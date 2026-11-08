回复 ../appendix/KMiri-interrupt.md

## 结论

  给 KMiri 增加中断模拟来检查这类死锁是可行的。针对 #4147 做出能触发并报告问题的最小实现，工作量中等；完整模拟可屏蔽、嵌套和多核中断，则是更大的工程。

  KMiri 已有可复用的基础：解释器会在 MIR 执行过程中计数并调度，也能把 Asterinas 的任务映射为解释器线程。Asterinas 的 Miri 架构也已有 IRQ 开关接口、定时器回
  调注册和 trap handler 代码。当前缺的是把这些部分连起来的模拟层：IRQ 开关仍是空操作，没有待处理中断队列，也没有 Miri 定时器触发中断回调的路径。

  ## #4147 的问题和现状

  issue 描述的死锁发生在单 CPU 上：

  1. 任务调用 sysinfo() 或读取 /proc/loadavg，持有 LOAD_AVG 读锁；默认 guardian PreemptDisabled 只禁止任务抢占，没有关闭本地 IRQ。
  2. 定时器中断打断该任务，回调进入 update_loadavg()，尝试获取同一锁的写锁。
  3. 写者自旋等待读者释放锁，但读者正被这个中断处理程序暂停，无法继续运行。

  本地 Asterinas checkout 仍能看到这段易受影响的代码：loadavg.rs (/home/zjp/KMiri/asterinas/kernel/core/src/sched/stats/loadavg.rs:33) 中锁使用默认
  guardian，读写路径分别在第 39–40、65 行；定时器回调注册在 scheduler_stats.rs (/home/zjp/KMiri/asterinas/kernel/core/src/sched/stats/
  scheduler_stats.rs:20)。

  GitHub 上的 issue 已于 2026-11-04 标记为完成关闭。 对应修复提交 c052edc
  (https://github.com/asterinas/asterinas/commit/c052edcf9543445664a85a40286bd8eeb5bb2d12) 将锁改为 RwLock<_, LocalIrqDisabled>，使读者持锁期间也屏蔽本地
  IRQ。这个改动给 KMiri 提供了明确的正反验证目标：旧代码应能复现问题；修复后的代码应让定时器事件挂起，等读锁释放后再执行写回调。


  ## 现有代码提供了什么

  • KMiri 在 machine.rs (/home/zjp/KMiri/kmiri/src/machine.rs:2019) 的解释器执行钩子中增加基本块计数，并推进虚拟单调时钟；thread.rs (/home/zjp/KMiri/kmiri/
    src/concurrency/thread.rs:1380) 有随机抢占逻辑，但默认 preemption_rate 是 0.0（eval.rs (/home/zjp/KMiri/kmiri/src/eval.rs:208)）。抢占在线程之间切换，不
    能单独表达“中断暂停当前任务，在同一 CPU 上嵌套运行 handler”。

  • KMiri 的 call_function (/home/zjp/KMiri/kmiri/src/helpers.rs:410) 能把 MIR 函数压入解释器调用栈。这可作为在安全调度点进入 handler 的基础，但还需正确构造
    调用参数、TrapFrame 和返回续接。

  • Asterinas Miri 架构的 irq.rs (/home/zjp/KMiri/asterinas/ostd/src/arch/miri/irq.rs:21) 中 enable_local()、disable_local() 是空操作，is_local_enabled() 恒
    为 true。因此 LocalIrqDisabled 在当前 Miri 架构下尚不能阻止模拟 IRQ。

  • Asterinas 的通用 timer/mod.rs (/home/zjp/KMiri/asterinas/ostd/src/timer/mod.rs:33) 已提供按 CPU 注册定时器回调的接口，也有执行回调并推进 jiffies 的函数
    （第 45–55 行）。但 Miri 架构的 timer/mod.rs (/home/zjp/KMiri/asterinas/ostd/src/arch/miri/timer/mod.rs:1) 目前主要定义频率，没有定时器事件投递。

  • Asterinas 已有 TrapFrame 和 Miri trap handler (/home/zjp/KMiri/asterinas/ostd/src/arch/miri/trap/mod.rs:34)，通用 IRQ 路径会调用 IRQ callback 和 bottom-
    half（irq/mod.rs (/home/zjp/KMiri/asterinas/ostd/src/irq/mod.rs:78)）。这降低了接入成本，但 Miri 仍需合成事件并调用这些已有路径。

  • Miri 架构目前报告单个处理器（boot/smp.rs (/home/zjp/KMiri/asterinas/ostd/src/arch/miri/boot/smp.rs:6)），适合先验证 issue 的单核自锁场景。

  ## 建议实现路径

  1. 先让 IRQ 开关状态真实可观察。 在 KMiri 或 Asterinas Miri shim 中维护每 CPU 的 IRQ enabled 状态；disable_local、enable_local、is_local_enabled 都读写同
     一份状态。状态最好由解释器统一维护，或明确规定内核侧状态与解释器状态如何同步，避免两边不一致。嵌套 guard 需要保留并恢复进入临界区前的状态。

  2. 实现可复现的虚拟定时器事件。 初期按基本块计数或显式配置的注入序号产生 timer IRQ，放入对应 CPU 的 pending 队列；IF 允许时才投递，屏蔽时保留待决事件。注
     入位置、事件序列和随机种子应能记录和重放。无需一开始精确仿真硬件频率：对 #4147，能稳定地在读锁存活期间安排一次 timer 就足以验证问题。

  3. 在解释器安全点进入中断处理。 对 issue 专用的 MVP，可以在模拟 timer 事件发生时执行 Asterinas 已注册的 timer callback 路径，并设置中断上下文和 IRQ 屏蔽状
     态。要覆盖一般 IRQ，再通过解释器调用机制进入 Miri trap handler，构造合适的 TrapFrame，在 handler 返回后恢复被中断执行。handler 执行期间不能让同一 CPU
     上被打断的任务继续前进。

  4. 增加死锁诊断。 Miri 的原子操作和借用检查通常不足以识别这个问题：读锁和写锁操作使用原子变量，故障表现是 ISR 永远自旋。KMiri 现有基本块计数和进度报告可提
     供看门狗的基础，但不会自动给出“IRQ handler 等待本 CPU 被暂停任务持有的锁”这样的诊断。短期可给中断处理设执行步数上限，超限后报告中断向量、CPU、当前 MIR
     调用栈和进度；更准确的方案是在 RwLock/SpinLock 获取、释放和等待路径记录锁地址、持有上下文与等待上下文，以识别自中断造成的等待环。

  5. 用修复前后代码验证。 在 issue 对应的旧代码上做确定性注入，安排 timer 在 LOAD_AVG 读锁持有时到达，期望产生明确的可能死锁诊断；在修复提交 c052edc
     (https://github.com/asterinas/asterinas/commit/c052edcf9543445664a85a40286bd8eeb5bb2d12) 上运行同样注入，期望中断先挂起，读锁释放后写回调完成。再覆盖
     IRQ 嵌套 disable/restore、timer pending、handler 返回恢复以及 might_sleep 的 IRQ 状态判断。

  ## 主要边界

  基本块边界是解释器可操作的注入点，不等同于真实 CPU 的任意指令边界。如果读锁获取、临界区和释放都落在单个基本块中，边界注入可能错过窗口；需要增加更细粒度的
  MIR 检查点，或提供围绕锁获取/释放的定向注入。用“中断期间超过步数预算”报告的是可能死锁，可能把很慢的合法 handler 也标记出来；锁持有者与等待者跟踪能提高诊断
  准确度。

  因此，KMiri 已具备推进此功能的解释执行和线程调度基础，但还不能靠现有随机抢占发现 #4147。最务实的路线是先实现单核、可屏蔽、可重放的 timer IRQ 模拟和 ISR 看
  门狗，再扩展通用 TrapFrame、嵌套 IRQ 与锁等待跟踪。

  我只做了代码和 issue 信息核对，没有修改仓库或运行测试。
