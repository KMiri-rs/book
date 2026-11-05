# 中断与引用有效性

## 一句话总结

> 在 Rust 内核中，`&mut` 的独占语义必须通过“关中断/锁/原子”等并发协议落地；否则中断重入可能把代码直接带入 UB。

## 1. 问题背景：`&mut` 与中断的语义冲突

`&mut T` 不只是“可写”，还隐含“独占可变访问路径”。

而中断是异步重入：普通路径执行到一半时，IRQ 处理例程可能修改同一内存。
如果普通路径仍按 `&mut` 独占假设优化，语义就会被破坏。

```rust
static mut COUNTER: u64 = 0;

fn normal_path() {
    unsafe {
        let c: &mut u64 = &mut COUNTER;
        *c += 1;
        *c += 1; // 这里若被 IRQ 改写同一内存，独占前提被破坏
    }
}

fn irq_handler() {
    unsafe { COUNTER += 1; }
}
```

这类问题不只是“计数不准”，而是可能触及未定义行为（UB）边界。

## 2. 临界区的本质：把语言契约变成运行时事实

临界区不是性能技巧，而是语义桥梁：

- 语言层：`&mut` 需要独占；
- 机器层：中断会异步打断；
- 工程层：通过临界区强制“当前这段代码确实独占”。

常见策略：

- 本核 ISR 共享：`local_irq_save/restore`；
- ISR + SMP 共享：`spin_lock_irqsave/unlock_irqrestore`；
- 简单标志/计数：`Atomic*`。

## 3. 具体示例：错误写法与修复写法

### 3.1 错误：共享可变状态无协议

```c
/* 线程上下文 */
state->x = 1;
state->y = 2;

/* 硬中断上下文 */
state->x = 3;
```

无论是 Rust 还是 C，这都是“并发写同一共享状态而无同步协议”。

### 3.2 修复 A：`spin_lock_irqsave`

```c
unsigned long flags;
spin_lock_irqsave(&state_lock, flags);
state->x = 1;
state->y = 2;
spin_unlock_irqrestore(&state_lock, flags);
```

语义：防本核 IRQ 重入 + 防跨核并发。

### 3.3 修复 B：仅计数场景用原子

```rust
use core::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn normal_path() {
    COUNTER.fetch_add(1, Ordering::Relaxed);
}

fn irq_handler() {
    COUNTER.fetch_add(1, Ordering::Relaxed);
}
```

## 4. `spin_lock_irqsave` 到底做了什么（代码链路）

可把它理解为：

1. 保存并关闭本地中断；
2. 获取自旋锁（与其他 CPU 互斥）；
3. 解锁后恢复中断状态。

对应调用形态：

```c
unsigned long flags;
spin_lock_irqsave(&lock, flags);
/* critical section */
spin_unlock_irqrestore(&lock, flags);
```

典型（非 RT）实现顺序可概括为：

```c
local_irq_save(flags);
preempt_disable();
raw_spin_lock(lock);
...
raw_spin_unlock(lock);
local_irq_restore(flags);
preempt_enable();
```

关键点：恢复的是“进入前状态”，不是无脑开中断。

## 5. 编译器重排：为何 irq 边界还要强调契约

常见误解：执行了 `cli` 就万事大吉。
实际要同时满足三层：

1. 执行层：中断确实被屏蔽；
2. 编译器层：访问不被搬出临界区；
3. SMP 层：跨核访问由锁/原子保证。

Linux 常见写法：

```c
asm volatile("cli" : : : "memory");
```

`"memory"` clobber 的作用是编译器屏障：
不允许把临界区访存跨越该边界乱移。

## 6. `compiler_fence`、`fence` 与 irq 场景

- `compiler_fence(Ordering::SeqCst)`：仅约束编译器重排；
- `fence(Ordering::SeqCst)`：约束编译器 + CPU。

在“防止编译器把访问漂移出 irq 临界区”这个目标上，`compiler_fence` 更精准。
但若底层 irq 原语已通过 asm+memory clobber 提供同等约束，再额外加 `fence` 可能只是更重。

## 7. 关闭抢占 vs 关闭中断：易错对照

- `preempt_disable()`：避免被调度切走，但硬中断仍可打断；
- `local_irq_disable/save()`：禁止本核硬中断，但不提供跨核互斥。

因此不能互相替代：

- 只关抢占：ISR 仍可能重入共享数据；
- 只关中断：仍需锁/原子处理 SMP 并发。

## 8. `PREEMPT_RT` 注意事项

在 `PREEMPT_RT` 配置下，`spinlock_t` 语义会变化（可睡眠化）。
这意味着“非 RT 上等价的写法”在 RT 下未必等价。

实践上要区分：

- 普通 `spin_lock_irqsave`（RT 语义会变）；
- `raw_spin_lock_irqsave`（保持 raw 自旋语义，常用于真正硬中断关键路径）。

## 9. Rust 侧最小实现骨架（示意）

```rust
use core::arch::asm;

#[inline(always)]
unsafe fn local_irq_save() -> u64 {
    let flags: u64;
    asm!("pushfq", "pop {}", out(reg) flags, options(preserves_flags));
    asm!("cli", options(nostack)); // 不要标 nomem/readonly/pure
    flags
}

#[inline(always)]
unsafe fn local_irq_restore(flags: u64) {
    const IF: u64 = 1 << 9;
    if flags & IF != 0 {
        asm!("sti", options(nostack));
    }
}
```

要点：如果不在原语内提供足够约束，调用点就必须补齐等价编译器屏障契约。

## 10. 审查清单（可直接用于 review）

1. 这块共享状态是否被 IRQ 与线程上下文同时访问？
2. 是否存在裸共享可变访问（无锁、无原子、无 irq 临界区）？
3. 若使用 `&mut` 假设，是否有机制保证其生命周期内不被异步改写？
4. SMP 路径是否仅关中断而忘了加锁/原子？
5. 进入/退出临界区是否正确保存并恢复中断状态？
6. RT/非 RT 语义是否混用？

## 11. 术语表

- **IRQ 重入**：同一 CPU 上，普通路径被中断后进入处理例程再访问同一共享状态。
- **本地关中断**：仅影响当前 CPU 的可屏蔽硬中断。
- **SMP 互斥**：跨 CPU 的并发互斥，通常由锁或原子建立。
- **compiler barrier**：仅限制编译器重排，不产生硬件内存屏障效果。
- **noalias/独占语义**：编译器可利用 `&mut` 独占假设进行优化。
- **`spin_lock_irqsave`**：关本地中断并获取自旋锁的组合原语。
- **`raw_spin_lock_irqsave`**：保持 raw 自旋锁语义，常用于硬中断敏感路径。

