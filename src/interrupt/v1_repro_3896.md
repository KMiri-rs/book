# 用 KMiri 复现 Asterinas Issue #3896

本文说明如何把 Asterinas [Issue #3896](https://github.com/asterinas/asterinas/issues/3896) 简化为 KMiri 内置测试，以及如何在 Asterinas OSDK 测试中走真实 OSTD 的 guard、RCU 和任务切换路径。Issue 已关闭为重复问题 #1120。可复现的代码组合由 safe API 构成；问题在于 `DisabledLocalIrqGuard` 的乱序析构破坏了它作为 `InAtomicMode` 证明的有效性。

## 故障机制

在当前 Asterinas 代码中，`DisabledLocalIrqGuard` 只保存进入时的 IRQ 状态。外层 guard 进入时保存 `was_enabled = true`，内层 guard 保存 `false`。若先析构外层 guard，它会重新开启本地 IRQ，即使内层 guard 仍然存活。内层 guard 实现了 `InAtomicMode`，`Rcu::read_with(&inner)` 返回的引用也借用了它；但此时任务已经可以切换。

`Rcu::update` 将旧对象放入延迟回收队列。真实任务切换进入 OSTD 的 `switch_to_task`：`might_sleep()` 看到 IRQ 已开启，随后 `finish_grace_period()` 把当前 CPU 记为通过静止态。在单 CPU 配置下，RCU 执行旧对象的回收回调；仍存活的 `read_with` 引用接下来访问已释放对象，形成 use-after-free。

关键实现可对照：[`ostd/src/irq/guard.rs`](https://github.com/asterinas/asterinas/blob/main/ostd/src/irq/guard.rs)、[`ostd/src/sync/rcu/mod.rs`](https://github.com/asterinas/asterinas/blob/main/ostd/src/sync/rcu/mod.rs)、[`ostd/src/task/processor.rs`](https://github.com/asterinas/asterinas/blob/main/ostd/src/task/processor.rs) 和 [`ostd/src/sync/rcu/monitor.rs`](https://github.com/asterinas/asterinas/blob/main/ostd/src/sync/rcu/monitor.rs)。

这与 [`v1.md`](v1.md) 中的 #4147 IRQ 自锁不同：#4147 让中断 handler 在同一任务栈上等待被打断任务释放锁；#3896 要求一个普通任务在 IRQ guard 错误地恢复 IRQ 后发生真实任务切换。#3896 不依赖 timer 注入或 IRQ handler watchdog。

## KMiri 内置 fail 测试的简化写法

KMiri 的 `tests/fail/kmiri/irq-self-deadlock.rs` 通过本地 shim 构造最小中断场景。对应的 #3896 测例已经实现于 [`tests/fail/kmiri/irq-rcu-uaf.rs`](../../../kmiri/tests/fail/kmiri/irq-rcu-uaf.rs)。它依次模拟以下操作：

1. 外层和内层 `IrqGuard` 都关闭 IRQ；外层记录原状态为 enabled，内层记录为 disabled。
2. 通过小型 `MiniRcu` 保存旧对象指针，并创建替代对象；旧对象先放入 retired 槽。
3. 先 drop 外层 guard，IRQ 被提前打开；模拟任务切换并释放 retired 对象。
4. 对仍保存的旧指针执行 volatile 读取，KMiri 预期报告访问已释放分配。

这个内置用例使用原始指针和 `unsafe` 访问来构造明确的悬空读取，适合确认 KMiri 能诊断等价的 UAF；它**模拟**了 RCU 与切换，不会执行 Asterinas 的 OSTD 实现。对应 `.stderr` 快照也已加入。真实 safe API 组合由下一节的 OSDK 测例覆盖。

从 KMiri 仓库根目录运行该内置测试：

```sh
./miri test kmiri/irq-rcu-uaf
```

这个小模型证明的是“KMiri 能发现与该生命周期错误等价的 UAF”。它不能证明 OSTD guard / `InAtomicMode` / RCU / scheduler 组合真实触发了问题。若希望内置测试覆盖 OSTD 真实实现，应使用下面的 Asterinas Miri 集成测试。

## Asterinas OSDK 测试的近似写法

参考 `../tests/irq-deadlock/src/lib.rs` 的 `#[ostd::ktest::miri_main]` 入口，真实 OSTD 测例已实现于 [`../tests/irq-rcu-uaf/src/lib.rs`](../../../tests/irq-rcu-uaf/src/lib.rs)。它直接使用 OSTD 的 `irq::disable_local`、`Rcu::read_with`、`Rcu::update` 和 `Task::yield_now`，并安排一个一直可运行的 peer task，确保 yield 能产生真实切换。

```rust
#![no_std]
#![deny(unsafe_code)]
#![feature(format_args_nl)]

extern crate alloc;

use core::sync::atomic::{AtomicBool, Ordering};
use ostd::{
    sync::Rcu,
    task::{Task, TaskOptions},
};

static PEER_READY: AtomicBool = AtomicBool::new(false);
static STOP_PEER: AtomicBool = AtomicBool::new(false);
static OLD_DROPPED: AtomicBool = AtomicBool::new(false);
static DRIVER_DONE: AtomicBool = AtomicBool::new(false);

struct Payload(u64);

impl Drop for Payload {
    fn drop(&mut self) {
        // 旧对象的 RCU 回调执行到这里，记录宽限期确实结束。
        OLD_DROPPED.store(true, Ordering::SeqCst);
    }
}

#[ostd::ktest::miri_main]
fn kernel_main() {
    let _driver = TaskOptions::new(|| {
        let _peer = TaskOptions::new(|| {
            PEER_READY.store(true, Ordering::SeqCst);
            while !STOP_PEER.load(Ordering::SeqCst) {
                Task::yield_now();
            }
        })
        .spawn()
        .unwrap();

        // 让 peer 先运行并进入持续可运行状态。
        while !PEER_READY.load(Ordering::SeqCst) {
            Task::yield_now();
        }

        let rcu = Rcu::new(Box::new(Payload(0xAA)));
        let outer = ostd::irq::disable_local();
        let inner = ostd::irq::disable_local();
        let old = rcu.read_with(&inner);

        drop(outer); // 非 LIFO：当前 guard 实现会在 inner 仍活着时开 IRQ
        assert!(ostd::irq::miri_local_irqs_enabled());
        rcu.update(Box::new(Payload(0xBB)));

        // 不调用私有/unsafe 的 finish_grace_period；只用真实任务切换推进 RCU。
        for _ in 0..128 {
            if OLD_DROPPED.load(Ordering::SeqCst) {
                break;
            }
            Task::yield_now();
        }
        assert!(OLD_DROPPED.load(Ordering::SeqCst), "RCU grace period did not finish");

        STOP_PEER.store(true, Ordering::SeqCst);
        Task::yield_now(); // 让 peer 退出，随后回到仍持有 old 的当前任务

        // 修复前，Miri 会在释放旧对象或下面读取旧对象时报告别名/释放后访问；
        // old 的借用期仍覆盖 inner。
        ostd::miri_println!("stale payload value: {:#x}", old.deref_target().0);
        drop(inner);
        DRIVER_DONE.store(true, Ordering::SeqCst);
    })
    .spawn()
    .unwrap();

    // 由显式 OSTD task 执行复现主体；入口等待它完成。
    while !DRIVER_DONE.load(Ordering::SeqCst) {
        Task::yield_now();
    }
}
```

OSDK 测例使用有界 yield，并在超时后明确断言，以免调度未发生时把它误判为 UAF。最初运行时它确实正常退出，并输出对象析构早于 stale read；原因和修复记录在下面的“为什么最初的 OSDK 测例没有报告 UB”小节。加入 slot 生命周期建模后，该 OSDK 路径会在 RCU 回收旧 `Payload` 时报告受保护引用仍存活的 UB，这是预期的失败结果。

## 为什么最初的 OSDK 测例没有报告 UB

KMiri 内置 `irq-rcu-uaf` 测例分配的是解释器直接管理的 allocation：释放会经过 Miri 的 allocator shim，旧 `Box` 对应的 allocation 会进入 dead allocation 表，之后的 stale read 因而能被诊断。OSDK 测例运行在 OSTD 内核堆上，`Box` 的 `GlobalAlloc` 实际使用 slab slot。此前 KMiri 只把 slab 页和 slot 大小建模为 typed page，并在访问时懒创建 slot allocation；OSTD 把 `Box` 释放到仍然存活的 slab 后，没有通知 KMiri 该 slot 已经结束。因此旧引用对应的 allocation 在解释器看来仍然有效，测试读到旧地址内容后正常退出。

不能只在 `GlobalAlloc::dealloc` 中结束 slot allocation。OSTD slab freelist 原本把 `next` 指针直接写进空闲 slot 的开头；若在 freelist 写入前结束 allocation，会错误地报告 allocator 自身写入；若结束后又用懒分配恢复 slot，链表字段则会变成未初始化。此外，直接用 dealloc 收到的指针结束 allocation 可能携带 `Box` 的派生借用 tag，导致错误地把 allocator 内部操作报成 provenance / borrow-stack UB。

修复在 KMiri 模式下把对象 allocation 生命周期与 slab freelist 元数据分开：

1. OSTD 将 slot 从 freelist 取出并作为 `GlobalAlloc::alloc` 的结果返回时，调用 `kern_miri_alloc_heap_slot`，KMiri 为该 typed slot 建立当前 generation 的 allocation。
2. 释放时 OSTD 先照常把 slot 归还 slab，再调用 `kern_miri_dealloc_heap_slot` 结束这个 generation。KMiri 用 allocation 的 root tag 执行 deallocation，避免把用户对象的派生 tag 当成 allocator 根指针。
3. KMiri 模式下 freelist 的 `next` 链接存入 `PhysicalMemory` 的影子表，通过 `kern_miri_set_heap_slot_next` / `kern_miri_get_heap_slot_next` 读写；硬件构建仍使用 slot 内原有的 intrusive link。这样 slot 空闲时其对象 allocation 可以结束，而 freelist 元数据仍可用。
4. OSDK 的 Miri linker template 导出上述 shim，让 KMiri foreign-item 实现能接管这些调用。

修复后的验证命令仍为：

```sh
cd ../tests/irq-rcu-uaf
OSDK_LOCAL_DEV=1 MIRIFLAGS="-Zkmiri-toml=$PWD/../asterinas.toml -Zmiri-permissive-provenance" cargo osdk miri test
```

预期命令以非零状态退出，并在 `ostd/src/mm/heap/mod.rs` 的 slot deallocation shim 处报告 `deallocating while item ... is weakly protected`。该报告发生在 `Rcu::finish_grace_period` 执行旧对象回收回调时：`Rcu::read_with` 返回的旧引用仍然存活，而其 `Box` 已开始释放，因而检查命中了 #3896 的借用生命周期错误。它不是 freelist 元数据访问导致的伪阳性。若诊断改为 slot_list 的 uninitialized read、freelist write 或普通地址映射错误，则说明 allocator 的建模仍有问题，不能算作本测例复现成功。

从 KMiri 仓库根目录运行 OSDK 测例：

```sh
make asterinas ASTERINAS_TEST=irq-rcu-uaf
```

此示例把 `Task::yield_now()` 置于 `kernel_main` 的 OSTD Miri 测试上下文，并依赖 `SMP=1`；运行配置应保持单 CPU，保证该 CPU 报告静止态就能结束当前 grace period。peer 的 `PEER_READY` 握手对应用户态复现中 fork + pipe 握手的作用：让 RCU 更新之后确实存在可运行的切换目标。

## 与 PR #30 的关系

[KMiri-rs/asterinas PR #30](https://github.com/KMiri-rs/asterinas/pull/30) 展示了更接近正常启动内核的用户态驱动版本。其 `ostd/src/kmiri_3896.rs` 把核心触发流程放进 OSTD；x86 私有 syscall 900 提供入口并把事件环拷回用户态；initramfs 中的 C 程序 fork peer，通过 pipe 握手后调用 syscall。事件环记录 `OuterNew`、`InnerNew`、`ReadWith`、`OuterDrop`、`Update`、`Reclaim`、`Use` 等事件，以 `Reclaim < Use` 作为观测判据。PR 描述的测试在一次正常启动中重复运行 10 次，并报告 10/10 命中。

PR #30 的用户态方案和本文的 ktest 方案目标不同：前者验证正常启动与用户态可达入口，后者是更短的 KMiri / OSTD 回归测试。二者都应保留真实 OSTD guard、RCU 和 scheduler 实现；人为构造的只有那次非 LIFO guard drop，以及为了确定性切换而安排的 peer。

## 推荐的验证分层

1. 用 KMiri 内置 fail 测例确认解释器能诊断一个最小模型中的释放后访问。
2. 用 OSDK Miri 测例检查真实 OSTD API 组合：先确认 IRQ 已提前恢复，再等 RCU `Payload::drop`，最后访问旧引用。
3. 如需确认正常启动路径，再采用 PR #30 的 debug syscall + 用户态 peer 驱动，并用事件序列而非内核打印判断 `Reclaim` 与 `Use` 的先后。

真实 OSTD 集成测例最重要的判据是旧对象析构发生在借用仍存活期间。只验证 `drop(outer)` 后 IRQ 已开启还不够；也只检查最终读到的旧值不可靠，因为释放后的内存内容不确定。固定单 CPU、确保 peer 可运行、并以析构事件或 Miri 的已释放内存诊断作为结果，才能把触发路径与 RCU 宽限期连起来。
