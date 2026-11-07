# KMiri 中断注入设计：原理、实现与源码索引
代码里确实不会有一行写着“我要中断了”。但真实硬件上也没有这一行，中断通常不是被打断的代码主动发起的，而是 **CPU 在指令边界等允许的时机响应中断**。在 KMiri 里，**Miri 扮演执行引擎**，所以检查可以放进解释器的执行循环，而不是放进内核业务代码。

下面先讲这个思路为什么成立，再讲具体怎么做。

## 一、真实 CPU 是怎么“直接就中断了”的

CPU 的执行循环可以粗略理解为：

```text
loop {
    执行一条指令
    if 有可投递的中断 && IF == 1 {   // 仅为简化模型
        保存被打断的现场
        按体系结构规则更新中断状态
        跳到中断向量表里的处理函数
    }
}
```

被打断的程序不需要显式调用中断处理函数，处理函数返回后，程序通常从被打断的位置继续执行。“中断没有写在代码里”并不妨碍它发生，因为响应中断的是执行硬件本身。

> 注意：`IF` 是借用 x86 的术语；不同架构的中断屏蔽位、异常入口、现场保存和返回规则不同。中断也不是无条件地在每条指令之后发生。

## 二、Miri 也有一个执行循环，而且已经在做类似的事

Miri 一步步解释 MIR，同样有执行循环。可以参考以下机制：

1. **抢占**：[搜索 `maybe_preempt_active_thread`](https://github.com/rust-lang/miri/search?q=maybe_preempt_active_thread&type=code)（原文定位：`concurrency/thread.rs:1362`；[KMiri 仓库对应搜索](https://github.com/KMiri-rs/miri/search?q=maybe_preempt_active_thread&type=code)）。Miri 能在解释执行过程中调度线程，而不需要被测代码显式写“我要被切走了”。这是**解释器主动引入调度事件**的先例。原文提到上游在基本块边界检查，并称 KMiri 的 [`eval.rs:209`（仓库搜索）](https://github.com/KMiri-rs/miri/search?q=preemption_rate&type=code) 将默认概率改成 `0.0`；这些具体实现位置和当前默认值仍需以目标提交为准。
2. **由解释器发起函数调用**：[搜索 `call_function`（上游 Miri）](https://github.com/rust-lang/miri/search?q=call_function&type=code)、[搜索 `call_function`（KMiri）](https://github.com/KMiri-rs/miri/search?q=call_function&type=code)（原文定位：`shims/helpers.rs:410` 附近）。解释器能够创建被解释函数的调用帧，让函数执行并在返回后恢复调用方；线程入口、TLS 析构等路径可作为进一步研究的参考。

中断可以借鉴这两种机制：**在安全的解释器调度点停下来，不一定切换线程，而是在当前执行上下文中调度中断入口**。但不能仅凭 `call_function` 存在，就断言直接压栈便能正确实现中断：还需要处理返回目标、重入、执行状态、trap frame 和架构语义。

## 三、demo 已经手写过这个模型

本地文件：`reports/kmiri-big-picture-20261104/motivating-demo-v2/src/main.rs`（本地路径，尚无可确认的公开仓库 URL）。

| demo 里手写的 | 含义 | KMiri 里应该放在哪 |
|---|---|---|
| `irq_point(n)`，作者手动插在代码里 | 这里可能被中断 | **解释器在基本块边界自动检查**，内核代码里不需要插入这些点 |
| `IRQ_ENABLED` | 本 CPU 的中断开关 | 解释器里每个 CPU 一个 IF 状态 |
| `IRQ_PENDING` | 关中断期间到达的中断先挂起 | 解释器里每个 CPU 一个待处理队列 |
| `deliver_irq()`：关 IF、调用 handler、恢复 IF | 模拟硬件进中断和出中断 | 解释器调度内核中断入口，返回时按架构规则恢复状态 |
| `IrqGuard::drop` 开中断时投递挂起的中断 | 重新允许投递积压的中断 | 开中断 shim 与事件投递逻辑协调 |
| `inject=N` | 在第几个点注入 | 可复现的注入策略 |

这里的“每个基本块边界”是建议的第一版实现粒度，并不等于真实硬件仅在基本块边界响应中断。

## 四、具体分五步

**① 把中断开关的状态搬进解释器**

原文提到的 [`arch/miri/irq.rs`（Asterinas 仓库搜索）](https://github.com/asterinas/asterinas/search?q=enable_local&type=code) 中，`enable_local()`、`disable_local()`、`is_local_enabled()` 的实现应当核对当前版本；原文称前两者为空函数，后者恒为 `true`。设计上可以将这些操作接入 shim，让解释器维护每 CPU 的中断允许状态。

解释器需要知道中断是否可投递。**但这不意味着只能将状态放在解释器里**：如果内核状态能够通过可观察的接口同步给解释器，也可以采用共享或镜像状态设计。关键是保证一致性。

原文提到 [`task/atomic_mode.rs` 中的 `might_sleep`（仓库搜索）](https://github.com/asterinas/asterinas/search?q=might_sleep&type=code) 依赖 `is_local_enabled()`。如果确实如此，中断开关模型会影响相关断言的准确性。

**② 中断从哪来：事件源**

- **时钟**：解释器维护虚拟时间，例如每执行 N 个基本块产生一个 tick，将时钟事件加入待处理队列。
- **设备**：对内核注册的 [`IrqLine`（仓库搜索）](https://github.com/asterinas/asterinas/search?q=IrqLine&type=code)，由测试脚本或配置生成对应中断事件。
- **IPI**：将 [`send_ipi`（仓库搜索）](https://github.com/asterinas/asterinas/search?q=send_ipi&type=code) 接到 shim，向目标 CPU 的待处理队列发送事件；多核语义可以后续实现。

**③ 什么时候检查：每个基本块边界**

参考 [Miri 抢占实现搜索](https://github.com/rust-lang/miri/search?q=maybe_preempt_active_thread&type=code)，在选定的解释器调度点检查：若有可投递的中断且 IF=1，则进入中断处理；若 IF=0，则按中断类型和屏蔽规则保留或处理待决状态。

shim 通常作为一次解释器操作处理，但**不能笼统认为所有 shim 都是不可中断的原子指令**；是否允许事件介入，应当由 shim 的实现和建模语义决定。

**④ 投递时做什么：模仿硬件，然后交给内核原有代码**

1. 按目标架构的规则更新中断屏蔽状态，并记录“现在处于中断上下文”。
2. 构造合适的 [`TrapFrame`（Asterinas 仓库搜索）](https://github.com/asterinas/asterinas/search?q=TrapFrame&type=code)；原文称 `arch/miri/trap` 中已有定义，具体路径需要核对。
3. 利用解释器函数调用机制（[KMiri `call_function` 搜索](https://github.com/KMiri-rs/miri/search?q=call_function&type=code)）进入内核中断入口，例如 [`trap_handler`（仓库搜索）](https://github.com/asterinas/asterinas/search?q=trap_handler&type=code)，再沿实际调用链找到 [`call_irq_callback_functions`（仓库搜索）](https://github.com/asterinas/asterinas/search?q=call_irq_callback_functions&type=code)。
4. 中断处理返回后，按目标架构的中断返回规则恢复执行上下文，被打断的代码继续执行。

目标是让内核原有的中断处理路径作为 MIR 被解释执行，从而接受 Miri 的检查。**是否能完整覆盖上半部、下半部以及中断返回时的调度行为，需要结合具体内核调用链验证**；不能仅凭进入 `trap_handler` 就认为所有路径都已覆盖。

**⑤ 在哪个点注入：真正的难题**

可以组合以下策略：

- **随机加种子**：参考 Miri 的 [`-Zmiri-preemption-rate`（源码搜索）](https://github.com/rust-lang/miri/search?q=preemption-rate&type=code) 和 [`-Zmiri-seed`（源码搜索）](https://github.com/rust-lang/miri/search?q=miri-seed&type=code)，实现可复现的注入。
- **小测试内核里穷举**：对应 demo 的 `inject=1/2/3`，适合回归测试。
- **重点注入**：关抢占但未关中断的区间、持锁期间、刚开中断时、访问 CPU-local 数据的前后。
- **记录注入点**：记录基本块计数、线程/CPU、事件序列和随机种子，以便精确重放；单独记录“第 12345 个基本块”未必足够。

## 五、注入之后，bug 怎么被发现

**许多内存安全问题可以复用 Miri 原有检查**。例如中断处理函数替换 `Vec` 并释放旧缓冲区，任务手里的引用可能悬空；恢复后读取可能触发释放后使用检测。别名模型也可能揭示非法访问，但具体诊断取决于引用、指针操作和采用的借用模型。

有两点要注意：

- **数据竞争检测不一定会报**：如果中断处理和被打断的代码被建模为同一个 Miri 线程上的顺序执行，通常不会被当作两个线程之间的数据竞争。中断导致的问题可能表现为别名违规、UAF 或重入错误；若模型引入并行 CPU，则需另行考虑并发检测。
- **死锁类问题可能需要新增检查**：例如 [Asterinas Issue #4147](https://github.com/asterinas/asterinas/issues/4147)（具体描述以 issue 为准）。如果中断上下文等待被打断代码持有的锁，可能无限自旋；可以记录锁的持有者与上下文关系，或设置自旋阈值辅助发现。

## 六、合法性：必须遵守中断开关

如果不管 IF 就随便注入，会让本来正确的代码出现假阳性。原文称 demo 的 `fixed + naive` 模式也触发了 UAF；这一实验结论需要结合本地 demo 日志核实。设计中必须保证中断屏蔽与投递规则匹配目标架构。

如果 [`is_local_enabled()`（源码搜索）](https://github.com/asterinas/asterinas/search?q=is_local_enabled&type=code) 仍恒为 `true`，直接以其返回值作为唯一判断依据就会错误地允许某些中断注入。

## 七、对内核的改动

尽量集中在 arch 层：[`irq.rs` 中断控制接口（源码搜索）](https://github.com/asterinas/asterinas/search?q=disable_local&type=code) 接 shim、注册中断入口、时钟与虚拟时间关联。目标是减少对 mm、task 等业务逻辑的侵入，但仍需核对现有架构抽象是否足够。

后续可扩展嵌套中断、多核 IPI、设备中断语义。第一期优先完成单核中断允许状态、时钟事件、内核中断入口与返回、以及可复现的事件轨迹。

---

## 代码仓库与入口

- [KMiri 仓库](https://github.com/KMiri-rs/miri)
- [上游 Miri 仓库](https://github.com/rust-lang/miri)
- [Asterinas（星绽）仓库](https://github.com/asterinas/asterinas)
- [Asterinas Issue #4147](https://github.com/asterinas/asterinas/issues/4147)

**链接准确性说明**：本文件中的 GitHub `search?q=...&type=code` 链接是可点击的代码搜索入口，**不是已核实的文件行号永久链接**。GitHub 代码搜索可能需要登录；要生成精确的 `blob/<commit>/<path>#L...` 链接，必须先确定项目使用的 commit 和对应源码位置。本地 demo 无公开 URL，因此未伪造远程链接。
