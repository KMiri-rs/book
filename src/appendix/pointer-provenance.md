# 指针出处与 LLVM IR

背景：[Pointer Provenance in Rust vs C++](https://sofiabelen.github.io/projects/pointer-provenance-in-rust-vs-cpp/)

> 本文整理自一次 LLVM IR 阅读会话：先逐段解释一段带调试信息的 IR，再澄清 `noundef` 与 `poison` 这两个阅读 IR 时绕不开的概念。可作为后续讨论指针来源（pointer provenance）之前的语言基础。

## 一段示例 IR

```llvm
define dso_local noundef i32 @f(int*)(ptr noundef %0) local_unnamed_addr #0 !dbg !14 {
  %2 = alloca i32, align 4
    #dbg_assign(i1 poison, !22, !DIExpression(), !23, ptr %2, !DIExpression(), !24)
    #dbg_value(ptr %0, !21, !DIExpression(), !24)
  call void @llvm.lifetime.start.p0(ptr nonnull %2) #3, !dbg !25
  store i32 1, ptr %2, align 4, !dbg !26
    #dbg_assign(i32 1, !22, !DIExpression(), !28, ptr %2, !DIExpression(), !24)
  tail call void @opaque(int*)(ptr noundef %0), !dbg !29
  call void @opaque(int*)(ptr noundef nonnull %2), !dbg !30
  %3 = load i32, ptr %2, align 4, !dbg !31
  call void @llvm.lifetime.end.p0(ptr nonnull %2) #3, !dbg !32
  ret i32 %3, !dbg !33
}
```

这是典型的、带调试信息的 LLVM IR（clang 在优化开启、`-g` 下生成，且是较新的 LLVM 18+ 输出——能看到新的 `#dbg_assign` 非指令调试记录和 `ptr` 不透明指针）。它对应的 C 源码大致是：

```c
int f(int *p) {
    int x = 1;       // alloca 出来的 %2
    opaque(p);       // 第一次调用，传参数本身
    opaque(&x);      // 第二次调用，传 x 的地址
    return x;        // load 回来返回
}
```

## 1. 函数头

```llvm
define dso_local noundef i32 @f(int*)(ptr noundef %0) local_unnamed_addr #0 !dbg !14
```

| 片段 | 含义 |
|------|------|
| `define` | 定义一个函数（有函数体） |
| `dso_local` | 符号在动态链接层面是本 DSO 内部的，链接器可据此做优化 |
| `noundef i32` | 返回类型是 32 位整数，`noundef` 保证返回值不会是 `undef`/`poison` |
| `@f(int*)` | 函数名 `f`，括号里的 `(int*)` 是它的参数类型列表 |
| `ptr noundef %0` | 唯一参数：一个指针（指向 `int`），`noundef` 保证非 poison，参数名 `%0` |
| `local_unnamed_addr` | 此函数的地址不重要（不会被取址比较），可做地址无关优化 |
| `#0` | 引用文件末尾的属性组 `#0`（`mustprogress uwtable ...` 等目标特性） |
| `!dbg !14` | 关联调试信息元数据 `!14` |

## 2. 函数体

```llvm
%2 = alloca i32, align 4          ; 在栈上分配一个 i32（4 字节对齐）→ 局部变量 x
```

`alloca` 是栈上分配，`%2` 就是 `x` 的地址。

```llvm
#dbg_assign(i1 poison, !22, !DIExpression(), !23, ptr %2, !DIExpression(), !24)
#dbg_value(ptr %0, !21, !DIExpression(), !24)
```

这两行以 `#` 开头、**不是真正的指令**，而是新式「调试赋值记录」（LLVM 18 起把原来的 `llvm.dbg.value` / `llvm.dbg.assign` 内在调用改成了这种非指令记录）。含义：

- `#dbg_assign(... ptr %2 ...)`：声明局部变量（`!22` 指向 `DILocalVariable`，即 `x`）的存储位置在 `%2`。第一个 `i1 poison` 表示这里是「取地址」语义而非具体值。
- `#dbg_value(ptr %0, !21, ...)`：参数 `p`（`!21`）的当前值是指针 `%0`。

```llvm
call void @llvm.lifetime.start.p0(ptr nonnull %2)
store i32 1, ptr %2
#dbg_assign(i32 1, !22, ...)   ; 记录 x = 1
```

- `llvm.lifetime.start` / `llvm.lifetime.end`：**生命周期标记**，告诉优化器 `x` 的存活区间（用于栈着色、逃逸分析）。参数只有 `ptr`，大小由指针指向类型推断（i32 → 4 字节）。
- `store i32 1, ptr %2`：即 `x = 1`。

```llvm
tail call void @opaque(int*)(ptr noundef %0)        ; opaque(p)
call void @opaque(int*)(ptr noundef nonnull %2)     ; opaque(&x)
```

- `opaque` 在文件末尾声明：`declare !dbg !34 void @opaque(int*)(ptr noundef)`——只有声明没有实现，表示一个外部/不透明函数，编译器无法看到它内部做什么。
- `tail`：尾调用**提示**标记（优化器/后端可忽略的 hint）。注意这里带 `tail` 的是第一次调用，而不是紧跟 `ret` 的那一次。
- 第二次调用传的是 `&x`（`%2`），`nonnull` 表明传入的指针保证非空（栈槽地址必然非空）。由于 `opaque` 可能修改 `x`，所以之后必须重新 `load`。

```llvm
%3 = load i32, ptr %2          ; 重新读 x（因为 opaque(&x) 可能改了它）
call void @llvm.lifetime.end.p0(ptr nonnull %2)   ; x 生命周期结束
ret i32 %3                     ; return x;
```

## 3. 尾部声明与属性组

```llvm
declare void @llvm.lifetime.start.p0(ptr captures(none)) #1
declare void @llvm.lifetime.end.p0(ptr captures(none)) #1
```

`lifetime.start/end` 是 LLVM 内置内在函数（intrinsic），`captures(none)` 表示它不会把指针捕获出去。

```llvm
attributes #0 = { mustprogress uwtable "min-legal-vector-width"="0" ... "target-cpu"="x86-64" ... }
attributes #1 = { mustprogress nocallback nofree nosync nounwind willreturn memory(argmem: readwrite) }
attributes #2 = { "no-trapping-math"="true" ... "target-cpu"="x86-64" ... }
attributes #3 = { nounwind }
```

常见项简述：

- `mustprogress`：该调用/函数保证最终会执行终止（不会无限循环）
- `uwtable`：生成栈展开表（供异常/调试展开）
- `nounwind`：不抛出异常
- `willreturn`：调用一定会返回
- `memory(argmem: readwrite)`：只读写被指向的内存（不影响其他内存）
- `"target-cpu"="x86-64"` 及 `+cmov,+sse2,+x87` 等：目标架构与特性
- `nocallback` / `nofree` / `nosync`：不回调用户代码 / 不释放内存 / 不同步

## 一句话总结

这段 IR 描述的是一个函数 `f(int *p)`：分配局部变量 `x` 并初始化为 1，先后调用两次不透明的 `opaque`（一次传 `p`，一次传 `&x`），最后重新加载并返回 `x`。其中 `alloca` + `lifetime.start/end` 是栈变量管理，`#dbg_*` 是调试信息（供 GDB 等在优化后的代码里映射回源码），`tail` 是尾调用提示。

---

# poison / undef / noundef

先给一句直觉区分：

| 概念 | 一句话 |
|------|--------|
| **poison** | 「未定义行为已经发生」的**延迟信号**，会沿指令传播，一旦被真正观察就升级成 UB |
| **undef** | 「未指定的值」，用的时候随便取一个都合法，本身**不是** UB，只是值不确定 |
| **noundef** | 一个**保证/属性**：这个值既不是 `undef` 也不是 `poison` |

## poison：延迟的 UB

`poison` 不是一个具体数值，而是一种「污染标记」。它由某些会产生未定义行为的操作产生，例如：

```llvm
%a = add nsw i32 %x, %y   ; 带 nsw：发生有符号溢出时，结果不是"绕回"，而是 poison
%b = udiv i32 %x, %y      ; 除数为 0 时，结果是 poison
%c = shl i32 %x, %y       ; 移位量 >= 位宽时，结果是 poison
%p = getelementptr inbounds ...  ; inbounds 越界时，结果是 poison
```

关键点在于它的传播规则：

1. **大多数指令会把 poison 传播到结果**——操作数是 poison，结果就是 poison。比如 `add`、`mul`、`load` 回来的值等。
2. **真正触发 UB 的是「观察」poison 的时候**。poison 被用于下面这些位置才算 UB：
   - 分支/开关的条件：`br i1 %cond, ...`（`%cond` 是 poison → UB）
   - 间接跳转/间接调用的目标地址
   - `load`/`store` 的**地址**（指针是 poison → UB）
   - `call` 的 callee（函数指针）

所以可以理解成：`poison` 是一种**延迟的未定义行为**。它先悄悄传播，直到撞上控制流、内存地址这类「必须确定」的地方，才真正变成 UB。这也是它和 C 语言 UB 语义的对应方式——LLVM 用 poison 来精确建模「某些优化假设被打破」的情形。

注意一个细节：`store i32 %poison, ptr %addr` 里，**值是 poison 是可以存的**（不会立刻 UB，之后 load 出来还是 poison）；但如果**地址**是 poison 就是 UB。

## undef：未指定值

`undef` 表示「随便哪个值都行」，典型来源是未初始化的内存：

```llvm
%x = alloca i32        ; 未写入，读取得到 undef
%y = load i32, ptr %x  ; %y 是 undef
```

使用 `undef` 本身不是 UB，它只是值不确定，优化器可以任意代入一个具体值。历史上 `undef` 甚至允许「每次使用取不同的值」。

**为什么两者要分开**：`poison` 是后来引入、用来修正 `undef` 的。`undef` 语义太松（可被替换成任意值），导致一些优化在传播上不够健全；`poison` 用「粘性传播 + 观察即 UB」把「由 UB 产生的值」建模得更精确、更保守，从而让优化既激进又正确。

## freeze：切断 poison/undef

如果编译器想把一个可能是 `poison`/`undef` 的值「固定成某个具体值」，用 `freeze`：

```llvm
%c = freeze i32 %x   ; 无论 %x 是 poison 还是 undef，%c 都变成一个确定的、可安全使用的值
```

## noundef：一个保证

`noundef` 是一个属性（attribute），表示「**这个值保证不是 `undef` 也不是 `poison`**」。它可以用在几个位置：

- **函数返回值**上：`define noundef i32 @f(...)` —— 该函数保证返回一个真实确定的值。
- **函数参数**上：`define ... @f(ptr noundef %0)` —— 调用者保证传进来的参数不是 poison/undef。
- **call 指令**的实参/返回值上：`call ... @opaque(ptr noundef nonnull %2)` —— 这里保证传出的指针既不是 poison、也不为空。

回到上面那段 IR 里的几处：

```llvm
define dso_local noundef i32 @f(int*)(ptr noundef %0) ...
                      ↑返回值非 poison/undef     ↑参数指针非 poison
call void @opaque(int*)(ptr noundef nonnull %2)
                          ↑传出的指针非 poison、非空
```

**它对优化有什么用**：`poison` 的存在会迫使优化器保守——它必须时刻维护「如果这个值被观察到就是 UB」的语义，不能随便把值假设成某个具体数。一旦有了 `noundef`，优化器就能放心地把这个值当成一个确定的真实值，从而做更激进的分析和变换（例如位分析、指针推导 `nonnull`、消除一些边界检查等）。本质上 `noundef` 是在替优化器「消掉需要处理 poison/undef 的心力」。

---

一句话总结：**poison 是「UB 已发生」的污染信号（观察才爆炸），undef 是「值未定」的任意值（观察无害），noundef 是「我保证这两个都不是」的声明**。

## 参考

- [LLVM Language Reference Manual](https://llvm.org/docs/LangRef.html)
- [LLVM LangRef — Poison Values](https://llvm.org/docs/LangRef.html#poison-values)
- [LLVM LangRef — Undefined Values](https://llvm.org/docs/LangRef.html#undefined-values)
