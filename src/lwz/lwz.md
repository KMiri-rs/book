# KMiri 蓝图：最终做成什么、为什么 Miri 不行、要加哪些机制、下一步做什么

> 2026-11-04 · 供组会汇报。依据：Codex 会话 `01a1a1cf` 的三份调研（`kernel-support-survey-20261103`、`kernel-target-selection-20261104`、`kernel-boot-status-20261104`）、`TASK_CONTEXT.md` 中已实测的案例、KMiri Book 核心设计，以及星绽 OSTD 源码快照（`reports/book-roadmap-core-20261019/sources/asterinas`）。
>
> 每条事实都标了证据等级：**【已实测】** 有运行日志；**【源码确认】** 读过源码但没运行；**【设计】** 是本文提出的方案或示意代码，还要验证。

---

## 0. 一页结论（组会第一张幻灯片）

1. **KMiri 的定位：** 有一类内核 bug 只在某个**内核事件**发生之后才出现。这类事件包括页被回收、映射被修改、中断到达、任务被抢占或迁移到另一个 CPU。在这些事件发生时，KMiri 仍要保持 Miri 的 Rust UB 检查有效，才能把这类 bug 查出来。
2. **为什么 Miri 不行：** 有两层原因。一是这些事件在 Miri 里**根本不会发生**，没有中断，也没有第二个 CPU；二是即使事件发生了，Miri 的检查状态**也不会同步更新**。例如页回收后，Miri 并不知道旧对象已经死了。
3. **为什么现在的 KMiri 也不行：** 内核能跑起来了，但事件模型不完整。中断开关都是空函数；页表只做地址翻译，不检查权限，也不模拟 TLB；第二个 CPU 没有接上。连已经接入的“内存回收”也有已实测的漏报和误报。
4. **要加 4 个机制：**
   - M1 内存效应保真：修底座。
   - M2 地址空间语义：页表加深。
   - M3 中断模型：最核心的新增。
   - M4 抢占与多核。

   每个机制都配了具体案例（第 3 节）。
5. **终点：** 星绽 OSTD 加内核组件能在 KMiri 里带着“中断、抢占、双核、真实地址空间语义”运行，跑定向场景测试和 ktest，查出事件相关的 bug；再用 BlueOS 验证同一套事件模型能迁移到另一个内核。**不做**的事：完整启动到用户进程、模拟设备、运行任意 ELF。
6. **下一步：** 先建**案例库**，每个机制写 2–3 个“正确写法/缺陷写法”的对照用例，在现有 KMiri 上跑一遍，填出 “Miri / 现有 KMiri / 目标 KMiri” 三列表。然后修 M1 里两个已实测的问题，接着做单核定时器中断（M3）。

---

## 1. 先把问题讲清楚

### 1.1 Miri 到底在检查什么

Miri 逐条解释执行 Rust 的 MIR。程序之外，它还维护一套**影子状态**：

| 影子状态 | 用来发现 |
|---|---|
| 每个对象的边界、是否已释放 | 越界、释放后使用（UAF） |
| 每个字节是否已初始化 | 读未初始化内存 |
| 指针来自哪个对象（provenance） | 野指针、用 A 的指针访问 B |
| 借用栈/借用树（SB/TB） | `&mut` 别名冲突等违反借用规则的行为 |
| 每个线程的向量时钟 | 数据竞争 |
| 线程是否全部阻塞 | 死锁 |

**关键点：** 这些检查成立的前提是影子状态和程序真实状态一致。

### 1.2 为什么 Miri 跑不了内核

普通程序的内存、线程和时间都由操作系统提供，内核则要自己实现这些东西：

- 内核直接拿**物理地址**用，自己决定哪一页放什么；Miri 里只有它自己分配的对象，没有“物理内存”。
- 内核用**页表**把虚拟地址翻译成物理地址；Miri 只有一种地址。
- 内核用**汇编**切栈、开关中断、换页表；Miri 不能解释汇编。
- 内核运行在**多个 CPU** 上，会被**中断**打断；Miri 里没有 CPU，也没有中断。

### 1.3 最重要的区分：两类内核 bug

| | A 类：代码局部 bug | B 类：环境事件 bug |
|---|---|---|
| 特点 | 把一段数据结构代码拿出来单独测试就能触发 | 代码单独看没问题，要某个内核事件在某个时刻发生才出错 |
| 例子 | BlueOS 已报到上游的 issue（[#523](https://github.com/vivoblueos/kernel/issues/523)、[#524](https://github.com/vivoblueos/kernel/issues/524)、[#526](https://github.com/vivoblueos/kernel/issues/526)、[#527](https://github.com/vivoblueos/kernel/issues/527)、[#528](https://github.com/vivoblueos/kernel/issues/528)、[#529](https://github.com/vivoblueos/kernel/issues/529)、[#531](https://github.com/vivoblueos/kernel/issues/531)、[#532](https://github.com/vivoblueos/kernel/issues/532)、[#533](https://github.com/vivoblueos/kernel/issues/533)、[#534](https://github.com/vivoblueos/kernel/issues/534)、[#535](https://github.com/vivoblueos/kernel/issues/535)）（rbtree、iheap、ilist、tinyarc 的借用冲突）【已实测】 | 页回收后被再次使用；撤销映射后没刷 TLB 就回收页；中断在持锁窗口到达；任务被迁移到另一个 CPU |
| 谁能查 | **普通 Miri 跑单元测试就够** | **只有 KMiri 有机会查** |
| 对论文的意义 | 有工程价值，但不算 KMiri 的方法贡献 | **论文的主战场** |

一个 B 类 bug 要被查出来，需要同时满足两个条件：

1. **可达（reachability）：** 事件真的在出错的时刻发生了。Miri 里永远不会来中断，也就永远走不到“中断打断持锁代码”这条路径。
2. **可见（oracle fidelity）：** 事件发生后，检查器的影子状态同步更新了。例如页被回收、旧对象死了，Miri 要知道；否则下次访问照样放行。

**论文就沿着这两条线写：** 现有 KMiri 的问题，有的在“可达”（中断、多核接不上），有的在“可见”（回收了却看不见，或者看错了）。

### 1.4 KMiri 现在怎么做，做到了哪里

KMiri 的做法是把自己当成一种 CPU 架构，叫 **Mirch**。内核像移植到新架构一样写一个 Mirch 架构层，用纯 Rust 替代汇编，在关键时刻调用 shim 通知解释器（分配页、改页的用途、换页表、建任务、切任务）。架构层以外的内核代码不用改，全部被解释并检查。

| 机制 | 已有 | 缺口 | 证据 |
|---|---|---|---|
| 页状态 | 页级 alloc / retype / dealloc 状态机 | slab 内单个对象回收看不见；漏发通知时静默；物理复制的初始化信息双向传错 | 【已实测】 |
| 页表 | 4 级页表地址翻译 | 不查读写权限；查不到映射时**回退到线性偏移**而不报错；没有 TLB；页表写入后的检查（`pt_checker`）是空的；全局只有一个根页表 | 【源码确认】Book |
| 任务 | 星绽真实 Task 的创建、切换、从暂停点恢复、退出（7 个集成测试通过） | BlueOS 普通任务切换仍 panic；[KMiri#277](https://github.com/KMiri-rs/KMiri/issues/277) 任务退出后线程不结束 | 【已实测】 |
| 中断 | **没有** | `arch/miri/irq.rs` 里 `enable_local()`、`disable_local()` 是空函数，`is_local_enabled()` 恒返回 `true`，`send_ipi` 为空，`enable_local_and_halt()` 为空 | 【源码确认】 |
| 多核 | 解释器底层有 2 个 CPU | 星绽 AP 启动函数为空，只跑 1 个 CPU；`kern_miri_get_cpu_local_va` 原样返回传入地址，两个 CPU 实际共用一份 per-CPU 数据 | 【源码确认】 |
| 用户态 | 没有 | `RawUserContext::run()` 为空；`kern_miri_copy` 星绽在调用，解释器却没实现 | 【源码确认】 |

**和已有工作的边界：** 物理内存、页状态、基础分页、初始化掩码已经发表在 Asterinas ATC'25 的 KernMiri（§6.3）里，**不能再当新贡献**。新贡献必须落在“事件”上。

---

## 2. Big Picture：最终的 KMiri 长什么样

```
┌──────────────────────────────────────────────────────────────────────┐
│  真实内核 Rust 代码：分配器、页表管理、调度器、中断处理、定时器、同步原语…   │
│  ——全部被解释执行、全部接受检查                                          │
├──────────────────────────────────────────────────────────────────────┤
│  Mirch 架构层（每个内核写一次，纯 Rust，替代汇编和特权指令）               │
├──────────────────────────────────────────────────────────────────────┤
│  KMiri 事件模型（本文要补全/新增的部分）                                  │
│                                                                      │
│   事件（让它发生）                    检查状态同步（让它被看见）           │
│   M1 页/对象的分配与回收   ──────▶   对象生命周期、初始化、provenance      │
│   M2 映射修改、TLB 刷新    ──────▶   地址→对象、读写权限、过期翻译         │
│   M3 中断到达与返回        ──────▶   中断上下文、借用、锁/睡眠契约         │
│   M4 抢占、迁移、IPI       ──────▶   CPU 归属、per-CPU 副本、向量时钟      │
│                                                                      │
│   事件调度：按种子随机 / 有界枚举注入点 / 记录并重放事件轨迹               │
├──────────────────────────────────────────────────────────────────────┤
│  Miri 原有检查：越界、UAF、未初始化、SB/TB 借用、数据竞争、死锁           │
└──────────────────────────────────────────────────────────────────────┘
```

KMiri 报出的错误分四类，汇报时不要都叫 “UB”：

| 类别 | 例子 | 由谁报 |
|---|---|---|
| Rust 语言级 UB | UAF、借用冲突、数据竞争、读未初始化 | Miri 原有检查（前提是状态同步正确） |
| 环境级错误 | 页状态非法转换、访问未映射地址、内核对象页被映射给用户 | KMiri 的页状态和页表检查 |
| 架构契约违反 | 刷 TLB 之前回收页；在中断上下文睡眠或拿不允许的锁 | KMiri 新增的契约检查 |
| 活性问题 | 中断处理拿不到被打断代码持有的锁；丢失唤醒导致永久睡眠 | 死锁诊断（扩展到中断上下文） |

**首篇论文的终点：** 星绽 OSTD 加内核组件在 KMiri 中，带着中断、抢占、双核和真实地址空间语义运行定向场景测试和 ktest。BlueOS 复用同一事件模型，接入中断和任务切换，证明方法能迁移。**不以“能启动到 init 进程”为目标**，用户态、系统调用、缺页闭环留到后续（M5）。

---

## 3. 四个机制与具体案例

案例在线来源入口：[KMiri 内存模型源码](https://github.com/KMiri-rs/miri/tree/e03a68f4b5f9fea572be5f4f68c55d80d28a8b9f/src/mirch)、[星绽 TLB 契约](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/mm/tlb.rs)、[中断适配源码](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/arch/miri/irq.rs)、[任务与调度源码](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/task)、[KMiri 集成测试](https://github.com/KMiri-rs/KMiri/tree/c321aacdbddd2ce634b7a6349c57c8ee78edcf42/tests)。这些链接提供对应源码、契约和用例，不替代本轮运行日志。设计/注入案例链接到本文方案，不冒充已有 issue。

每个案例按同一格式写：场景 → 真实机器上的后果 → 为什么 Miri 查不出 → 为什么现在的 KMiri 也查不出 → 需要什么机制、由哪类检查报出。

### M1 内存效应保真（修底座，优先级最高、工作量最小）

**目标：** 内核自己的分配器回收或复用内存时，Miri 的对象生命周期、初始化和 provenance 要跟着正确变化。普通 Miri 不执行内核分配器，所以**这是 KMiri 特有的问题**：内核分配器一旦被解释执行，“对象交给客户”和“对象还给分配器”这两次所有权交接都要建模。

<a id="case-c1-1"></a>

#### 案例 C1.1：已释放对象被“复活”，UAF 漏报【已实测】

- **场景：** [RFL #1261](https://github.com/Rust-for-Linux/linux/issues/1261) / [miri#64](https://github.com/KMiri-rs/miri/pull/64)。`RawFormatter` 把缓冲区存成 `buf as usize`；缓冲区（KVec）释放后，它又把这个整数转回 `*mut u8` 写入。
- **真实后果：** 释放后写入。
- **普通 Miri：** **能报**（dangling）。
- **现有 KMiri：** **漏报，退出码 0**。原因是整数转回的指针走 wildcard 地址解析，查不到活对象时，`kernel_allocation_at` 会在同一地址**新建一个活对象**，写入就成功了。也就是说，内核内存模型让 KMiri 在这一点上**比普通 Miri 还差**。
- **验证：** 加了“墓碑”实验补丁之后，同一用例在 `str.rs:631` 报 dangling。
- **同类问题（Book 已写明）：** 页内 slab slot 在 retype 时就固定了，对象只在整页释放时删除。所以“页还在，但其中某个对象已被 slab 回收”之后的访问也查不出来。
- **需要的机制：** **对象级生命周期**。分配器回收对象时通知解释器，或者解释器记录“已释放区间”。懒创建对象时必须分清“从没分配过的 slot”和“已经释放的对象”。由 Miri 原有的 UAF 检查报出。

<a id="case-c1-2"></a>

#### 案例 C1.2：对象还给分配器时误报【已实测】

- **场景：** 星绽 [KMiri#283](https://github.com/KMiri-rs/KMiri/issues/283)、[KMiri#284](https://github.com/KMiri-rs/KMiri/issues/284)（T2、T3）。释放一个 `Box<u32>` 或 3 字节的 `CString` 时，`AllocDispatch::dealloc` 拿客户的指针原样包装成 `HeapSlot`，`SlabSlotList<8>::push` 再通过它写 8 字节的空闲链表 next 指针。
- **真实后果：** 没有 bug。slot 本身有 8 字节，分配器拥有整个 slot。
- **现有 KMiri：** SB 认为这个指针只有 4 或 3 字节的权限，**报 UB（误报）**。
- **普通 Miri：** 根本不执行这段分配器代码，所以不会遇到。
- **需要的机制：** **分配器边界的所有权交接**。对象回到分配器时，从 slot 的基址恢复整槽权限；交给客户时，再收窄到对象大小。

<a id="case-c1-3"></a>

#### 案例 C1.3：物理复制把初始化信息传错【已实测，2026-10-03】

[物理复制实现](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L197-L295) · [已初始化复制回归](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/tests/pass/kmiri/physical-copy-initialized.rs) · [未初始化复制回归](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/tests/fail/kmiri/physical-copy-uninitialized.rs)

- `physical_copy` 在两个方向上都传错了初始化状态：从已初始化复制到未初始化的目标会误报；从未初始化复制到已初始化的目标会漏报。
- **需要的机制：** 复制、清零类 shim 必须同步初始化掩码。这是工具模型的缺口，不是内核 bug。

<a id="case-c1-4"></a>

#### 案例 C1.4：架构层漏发通知时完全静默【已实测】

- **场景：** 星绽 K6、K6b（[asterinas#27](https://github.com/KMiri-rs/asterinas/pull/27)）。普通物理页和连续段释放时，Mirch 层没有通知 KMiri，KMiri 一直认为这些页还活着，之后的 UAF 全部漏报。
- **需要的机制：** **适配一致性检查**，在检查点比对内核自己的帧元数据和 KMiri 的页状态。优先级较低，但论文讨论“适配可信度”时需要它。

> **为什么先做 M1：** 后面 M3 的“定时器回调访问已释放对象”（[C3.4](#case-c3-4)）要靠 [C1.1](#case-c1-1) 修好才能报出来。地基不对，加了中断也看不见。

---

### M2 地址空间语义（页表加深）

**目标：** 页表不只用来翻译地址，还要承载真实硬件的约束：映射是否存在、读写权限、TLB 过期。

**KMiri 已有的优势：** 两个虚拟地址映射到同一物理页时，它们会落到同一个 Miri 对象上，跨地址的借用和竞争检查自然成立。普通 Miri 一个对象只有一个地址，做不到这一点。

<a id="case-c2-1"></a>

#### 案例 C2.1：撤销映射后仍访问【源码确认，待写用例】

```rust
vm_space.unmap(va..va + PAGE_SIZE);          // 撤销映射
let x = unsafe { *(va as *const u64) };      // 真实机器：内核态缺页 → oops
```

- **现有 KMiri：** 页表查不到映射时，**按内核代码区或启动线性映射的固定偏移算出物理地址**，读取成功，不报错（Book 已写明的缺口）。
- **需要的机制：** **严格翻译**。查不到映射就报“访问未映射地址”。用户地址以后（M5）再转给缺页处理。

<a id="case-c2-2"></a>

#### 案例 C2.2：通过只读映射写入【源码确认】

- 当前翻译只看“有效”和“大页”两位，不看读写权限。
- **需要的机制：** 翻译时检查 R、W 权限（以后再加 U 和 X）。

<a id="case-c2-3"></a>

#### 案例 C2.3：没刷 TLB 就回收页【源码确认契约，缺陷写法为示意】

星绽 [`ostd/src/mm/tlb.rs`](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/mm/tlb.rs) 里 `TlbFlusher::issue_tlb_flush_with` 的文档原话：

> "If we need to remove a mapped page from the page table, we can only recycle the page after all the relevant TLB entries in all CPUs are flushed. Otherwise if the page is recycled for other purposes, the user space program can still access the page through the TLB entries."

```rust
// 正确写法：刷完 TLB 才回收页
flusher.issue_tlb_flush_with(op, frame_to_drop);
// 缺陷写法【设计/注入】：
flusher.issue_tlb_flush(op);
drop(frame);          // 页立刻回到分配器，可能分给别人；但 TLB 仍然指向它
```

- **真实后果：** 页被别人重新使用，旧的 TLB 项还能读写它，相当于物理页级别的 UAF。只在特定时序下发生，在 QEMU 上很难复现。
- **普通 Miri：** 没有页表，也没有 TLB。
- **现有 KMiri：** 星绽 Mirch 层刷 TLB 是空操作；KMiri 每次都按页表**最新**内容翻译，相当于 TLB 永远是最新的，过期翻译根本不存在。
- **需要的机制：** **过期翻译跟踪**。修改或删除 PTE 后，为曾经用过旧翻译的 CPU 记一条“过期翻译”，直到该 CPU 刷新为止。存在过期翻译时回收对应物理页，就报**架构契约违反**。单核版本只需要“本 CPU 是否已刷”，多核版本与 M4 的 IPI shootdown 联动。

<a id="case-c2-4"></a>

#### 案例 C2.4：内核对象页被映射出去【源码确认】

- 星绽的 framekernel 安全设计依赖一条规则：只有 untyped 页能映射给用户；slab 页、页表页这类 typed 页不能映射出去。
- KMiri 已经能察觉“页表页被写入”，但写入后的检查（`pt_checker`）是 TODO。
- **需要的机制：** 页表写入后检查映射不变量，例如 typed 页映射到用户地址、同一内核对象出现两个可写别名。

---

### M3 中断模型（核心新增，普通 Miri 完全没有的能力）

**目标：** 中断能在合法的时刻到达，执行内核**真实的**中断处理代码，同时检查器知道“现在处于中断上下文、打断的是谁”。

**现状【源码确认】：** 星绽 [`ostd/src/arch/miri/irq.rs`](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/arch/miri/irq.rs)：

```rust
pub(crate) fn enable_local() {}
pub(crate) fn disable_local() {}
pub(crate) fn is_local_enabled() -> bool { true }
pub(crate) fn send_ipi(cpu_id: HwCpuId, guard: &dyn PinCurrentCpu) {}
pub(crate) fn enable_local_and_halt() {}
```

后果有两条：

- 中断从来不会到达，所有中断处理器、定时器回调都不可达。
- 星绽中很多安全性依赖“中断已关”，例如 `CpuLocal::get_with(&DisabledLocalIrqGuard)`、`LocalIrqDisabled` 自旋锁。现在关中断是空操作，这些前提在 KMiri 里**根本没有被检验**。

<a id="case-c3-1"></a>

#### 案例 C3.1：中断处理器和被打断的代码同时持有 `&mut`（Rust UB）【设计/注入，按星绽 API 写】

```rust
// 每 CPU 一份的统计结构，用 UnsafeCell 存
fn record(e: Event) {
    let _g = disable_preempt();                       // 缺陷：只关了抢占，没关中断
    let s: &mut Stats = unsafe { &mut *STATS.get() };
    s.events.push(e);                                 // ← 定时器中断可能在这里到达（甚至在 push 扩容的中途）
}

fn on_timer(_: &TrapFrame) {                          // 定时器中断处理
    let s: &mut Stats = unsafe { &mut *STATS.get() };
    s.events.clear();
}
```

- **真实后果：** 单核上就会内存损坏，概率很低，测试中极难复现。
- **普通 Miri：** 没有中断，`on_timer` 永远不会在 `record` 中途执行。把两个函数分别拿出来做单元测试都能通过。
- **现有 KMiri：** 同样不会注入中断。
- **目标 KMiri：** 在 `record` 内部注入定时器中断，在**同一线程上嵌套执行**真实的 `on_timer`。`on_timer` 新建的 `&mut` 让 `record` 手里那个 `s` 的借用失效；中断返回后 `record` 继续使用 `s`，SB/TB 当场报 UB。如果 `clear` 释放了 `push` 正在用的缓冲，就报 UAF。报告附带“中断在哪一条语句注入”的事件轨迹，可以重放。

> 这是论文里最好讲的例子。它报出来的是 Miri 的“老本行”Rust UB，但只有 KMiri 能让这条路径发生。

<a id="case-c3-2"></a>

#### 案例 C3.2：违反锁的中断契约导致单核死锁【源码确认契约】

星绽 [`ostd/src/sync/guard.rs`](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/sync/guard.rs) 中 `WriteIrqDisabled` 的文档原话：

> "holding the read lock will only disable preemption, but holding a write lock will disable local IRQs. **The user must ensure that the IRQ handlers never take the write lock**…"

这条契约只写在文档里，**没有任何检查**。缺陷写法：任务持读锁时（中断是开着的）来了中断，中断处理器去拿写锁。单核上，持读锁的代码要等处理器返回才能继续，处理器又在等读锁释放，结果是永久自旋。`PreemptDisabled` 自旋锁在中断处理器里被使用也是同一类问题。

- **普通 Miri 和现有 KMiri：** 都不会来中断。
- **需要的机制：** 解释器给每个 CPU 记录“当前在中断上下文、被打断的是哪个执行流”。中断处理器等待的锁，如果由被它打断的同 CPU 执行流持有，就报**中断上下文死锁**。“中断上下文里不能睡眠或阻塞”这类契约也在这里统一检查。

<a id="case-c3-3"></a>

#### 案例 C3.3：丢失唤醒（活性问题）【源码确认契约】

星绽 [`sync/wait.rs`](https://github.com/KMiri-rs/asterinas/blob/9d6ad64d5ba92a6f94ac8534e4ec29c5198983b6/ostd/src/sync/wait.rs) 的文档要求：唤醒方必须**先**让条件成立，**再**调用 wake，否则等待方可能丢失唤醒。缺陷写法【设计/注入】：手写“先检查条件、再睡眠”，两步之间没有入队保护。

```rust
if !EXPIRED.load(Acquire) {
    // ← 定时器中断在这里到达：处理器设置 EXPIRED 并调用 wake_one()，但此时等待队列还是空的
    waiter.wait();                 // 睡下去后再也没人唤醒
}
```

- **需要的机制：** 虚拟时钟驱动的定时器源、在 ① 和 ② 之间注入中断，还要有真实的空闲/halt 语义（现在 `enable_local_and_halt()` 为空，idle 只会空转）。所有任务都阻塞、又没有待到期的定时器时，就报死锁。

<a id="case-c3-4"></a>

#### 案例 C3.4：定时器回调访问已释放的对象（依赖 M1）【设计/注入】

```rust
let buf = Box::new([0u8; 64]);
let p = &*buf as *const _ as usize;
timer.set_timeout(ms(10), move || unsafe { log((p as *const [u8; 64]).read()) });
drop(buf);                         // 缺陷：没先取消定时器
```

- 定时器到期时回调执行，形成 UAF。
- **普通 Miri：** 定时器永远不会到期。
- **现有 KMiri：** 同样不会到期；即使到期了，整数转指针这条路也会撞上 [C1.1](#case-c1-1) 的“复活”漏报。**这个案例同时需要 M1 和 M3**，正好说明 M1 要先做。

#### M3 的机制设计【设计】

1. **中断状态归解释器管：** 新增 shim（例如 `kern_miri_irq_enable`、`kern_miri_irq_disable`、`kern_miri_irq_is_enabled`、`kern_miri_halt`），每个 CPU 记一个 IF 标志。星绽的 `arch/miri/irq.rs` 改为调用这些 shim。
2. **中断源：** 先只做**一个定时器源**，用虚拟时间（比如按执行的基本块计数）推进；IPI 留给 M4。
3. **注入策略：** 只在“中断已开”时、MIR 语句边界上注入。用种子控制是否注入和注入位置，并限制总次数（有界）；也可以对一个指定区间做穷举。每次运行都记录事件轨迹，以便重放。
4. **执行处理器：** 在被打断的线程上压一个“中断帧”，调用内核注册的真实 trap 入口（星绽 `CallbackElement::call` 那一套），返回后恢复被打断的代码。这样处理器代码也全部接受检查。
5. **并发语义：** 同一 CPU 上，中断处理器和被打断的代码是程序顺序，**不能**报成数据竞争，但借用冲突照样要报（[C3.1](#case-c3-1) 靠的就是这个）。跨 CPU 的访问照常走向量时钟。
6. **契约检查：** 中断上下文里睡眠、阻塞，或者等待被自己打断的执行流持有的锁，都要报出来。

**第一版范围：** 单核、一个定时器源、不嵌套中断、轨迹可重放。

---

### M4 抢占与多核

**目标：** 定时器中断能触发真实调度器的抢占；两个 CPU 都真正跑起来，per-CPU 数据真的各有一份；跨核同步（IPI、TLB shootdown）进入检查。

<a id="case-c4-1"></a>

#### 案例 C4.1：per-CPU 数据没有真正分开【源码确认】

- `kern_miri_get_cpu_local_va` 现在原样返回传入地址。两个 CPU 读写的其实是**同一份** per-CPU 数据：本该隔离的访问会被误报成竞争，真正的跨 CPU 误用又查不出来。
- **需要的机制：** 按 CPU 重定位 CPU-local 地址（Book 设计里已有，还没启用）。

<a id="case-c4-2"></a>

#### 案例 C4.2：迁移后还在改原 CPU 的 per-CPU 数据【设计/注入】

```rust
let p: *mut Counter = cpu_local_ptr_without_pin();   // 缺陷：没有关抢占或固定 CPU 就取了当前 CPU 的副本
// ← 定时器中断 → 抢占 → 任务被迁移到 CPU1
unsafe { (*p).n += 1 };                              // 在 CPU1 上改 CPU0 的副本，与 CPU0 上的新任务并发
```

- 星绽用 `PinCurrentCpu`、`DisabledPreemptGuard` 这类守卫在类型层面防止这个问题，缺陷来自绕过守卫的 unsafe 代码。
- **需要的机制：** M3 的定时器抢占、真实的两个 CPU、迁移，再加上 [C4.1](#case-c4-1)。之后由 Miri 的向量时钟报**数据竞争**。

<a id="case-c4-3"></a>

#### 案例 C4.3：跨核 TLB shootdown（C2.3 的多核版）【源码确认】

- 星绽 `dispatch_tlb_flush` 先通过 IPI 让其他 CPU 刷新，再在本 CPU 刷新；KMiri 里 `send_ipi` 是空的。
- **需要的机制：** IPI 作为 M3 中断源的一种，加上每个 CPU 各自的过期翻译。这样就能检查“远端 CPU 还没刷完就回收页”。

<a id="case-c4-4"></a>

#### 案例 C4.4：跨核唤醒丢失、AP 启动【源码确认】

- 星绽 Mirch 的 AP 启动函数为空，第二个 CPU 从未运行过真实内核代码。先让 AP 走星绽真实的 AP 启动路径，才能谈跨核唤醒。

**探索策略：** 不做 GenMC 式的穷举（它要求关闭 SB/TB）。采用**种子随机加有界注入点、可重放**，与 M3 共用同一套事件调度。

---

### M5（不在首篇范围）用户态边界

系统调用入口、`copy_from_user`（星绽 `mm/io/copy.rs` 调用的 `kern_miri_copy` 还没实现）、用户地址缺页。ELF 机器码不会自动变成 MIR，需要单独的“用户执行桥”。列为长期目标，首篇论文不承诺。

---

## 4. 案例总表（组会汇报用）

| 案例 | 类别 | 普通 Miri | 现有 KMiri | 目标 KMiri | 依赖机制 | 证据 |
|---|---|---|---|---|---|---|
| [C1.1](#case-c1-1) 已释放对象被复活 | UAF | 能报（用户态对应写法） | **漏报** | 报 dangling | M1 | 已实测 |
| [C1.2](#case-c1-2) 回收时整槽写入 | 误报 | 不执行分配器 | **误报** | 正常通过 | M1 | 已实测 |
| [C1.3](#case-c1-3) 复制传错初始化信息 | 误报 + 漏报 | — | **双向错误** | 正确 | M1 | 已实测 |
| [C1.4](#case-c1-4) 漏发释放通知 | UAF 漏报 | — | 静默 | 一致性检查报出 | M1 | 已实测 |
| [C2.1](#case-c2-1) 撤销映射后访问 | 环境错误 | 无页表 | 回退线性映射，**放行** | 报未映射访问 | M2 | 源码 |
| [C2.2](#case-c2-2) 只读映射写入 | 环境错误 | 无页表 | 放行 | 报权限错误 | M2 | 源码 |
| [C2.3](#case-c2-3) 未刷 TLB 就回收页 | 架构契约 | 无 TLB | 看不见 | 报契约违反 | M2（+M4） | 源码契约 |
| [C2.4](#case-c2-4) typed 页映射出去 | 环境错误 | 无页表 | 检查为空 | 报映射不变量 | M2 | 源码 |
| [C3.1](#case-c3-1) 中断处理器与任务 `&mut` 冲突 | Rust UB | 不可达 | 不可达 | SB/TB 报 UB | M3 | 示意 |
| [C3.2](#case-c3-2) 中断处理器拿写锁 | 活性/契约 | 不可达 | 不可达 | 报中断上下文死锁 | M3 | 源码契约 |
| [C3.3](#case-c3-3) 丢失唤醒 | 活性 | 不可达 | 不可达 | 报死锁 | M3 | 源码契约 |
| [C3.4](#case-c3-4) 定时器回调 UAF | UAF | 不可达 | 不可达且会漏报 | 报 UAF | M1 + M3 | 示意 |
| [C4.1](#case-c4-1) per-CPU 未隔离 | 误报/漏报 | 无 CPU | 共用一份 | 正确隔离 | M4 | 源码 |
| [C4.2](#case-c4-2) 迁移后改原 CPU 数据 | 数据竞争 | 不可达 | 不可达 | 向量时钟报竞争 | M3 + M4 | 示意 |
| [C4.3](#case-c4-3) 跨核 TLB shootdown | 架构契约 | 不可达 | IPI 为空 | 报契约违反 | M2 + M3 + M4 | 源码 |

“示意”表示缺陷写法是我们按真实 API 注入的。论文里还要找**真实历史 bug**来填充（见第 6 节 P 任务）。

---

## 5. 论文怎么写

**题目方向：** *KMiri: Event-Faithful Undefined Behavior Detection for Rust Kernels*，意思是在内核事件下保持保真的 Rust 内核 UB 检测。

**核心论点：** 有一类 Rust 内核 bug 依赖内核事件（内存回收、映射变化、中断、抢占和多核）。要检测它们，需要同时让事件**可达**、让检查状态**保真**。KMiri 用“伪架构加事件模型”做到这两点，并且保留 Miri 全部检查能力，不靠关闭 SB/TB 来跑通。

**贡献点（候选）：**

1. **问题刻画：** 区分代码局部 bug 和环境事件 bug；指出直接把 Miri 搬进内核会出现两类失真：资源回收导致对象复活（[C1.1](#case-c1-1)），以及分配器所有权交接导致误报（[C1.2](#case-c1-2)）。
2. **中断模型：** 合法时刻注入、真实处理器嵌套执行、中断上下文契约检查、可重放轨迹（M3）。这是相对 KernMiri 最清楚的新增。
3. **地址空间语义：** 严格翻译、权限检查、过期 TLB 契约（M2）。
4. **多核与抢占：** 真实 AP、per-CPU 重定位、迁移、IPI（M4）。
5. **评测：** 星绽加 BlueOS 两个内核。

**评测问题：**

- **RQ1 检测能力：** 在案例库上比较 Miri、现有 KMiri 和完整 KMiri 的检出情况（第 4 节的表就是雏形）。必须分开统计“新事件让 bug 第一次可达”和“检查保真后才报出”这两种来源。
- **RQ2 真实 bug：** 在星绽和 BlueOS 的中断、定时器、TLB、per-CPU 相关路径上复现历史 bug，并找新 bug。历史复现、人工注入和新发现分开计数。
- **RQ3 误报：** 合法写法、现有 ktest 和集成测试在完整 KMiri 下是否仍然通过。
- **RQ4 可移植性：** 把 BlueOS 接入中断和任务切换的改动量（Mirch 层行数、shim 数）和星绽对比。
- **RQ5 开销：** 解释开销，以及注入预算与检出之间的关系。

**风险与止损：**

- 最大的风险是**真实新 bug 太少**。缓解办法：尽早挖星绽的提交历史（P 任务），优先选中断、定时器、TLB 这类“测试难覆盖”的代码。
- 如果某个检出普通 Miri 也能做到，或者全靠补启动 shim 才跑通，就不能算方法贡献，只能作为工程成果。

**和 Codex 报告的对应关系：** Codex 说的 “G0 内存底座可信” 就是这里的 M1。“单核真实任务” 在星绽上已经实测完成（7 个集成测试），不需要单独再做一个阶段。它给的排序“内存 → 中断 → 页表 → 多核”与本文一致；本文补上的是**每一步具体要解决哪个案例，以及怎么验收**。

---

## 6. 下一步任务单（可直接分工）

| 序号 | 任务 | 产出 | 验收 | 预估 |
|---|---|---|---|---|
| **T0** | **建案例库**：第 4 节每个案例写成 KMiri 测试内核（`KMiri/tests/case-*`），各有正确和缺陷两种写法，在现有 KMiri 上各跑一遍 | 三列表的“现有 KMiri”一列有真实结果；M3、M4 的用例先标 `unsupported` | 每个用例都写明预期的检查结果（报什么、在哪一行） | 1–2 周 |
| **T1** | **M1 修复**：[C1.1](#case-c1-1) 对象级生命周期（把墓碑实验正式化，加上 slab 对象回收通知）和 [C1.2](#case-c1-2) 分配器所有权交接 | 2 个 miri PR，每个附 `tests/pass/kmiri`、`tests/fail/kmiri` 回归用例 | 修复前后同一用例对照；`./miri test kmiri` 通过；星绽 7 个集成测试不退化 | 2–3 周 |
| **T2** | **M3 最小中断**：单核、一个定时器源、不嵌套；解释器侧加 IF 状态、注入、中断帧和轨迹，星绽侧改 `arch/miri/irq.rs`、timer、trap 入口 | [C3.1](#case-c3-1)–[C3.4](#case-c3-4) 可运行 | 缺陷写法报出预期错误，正确写法通过；同一种子可重放；原有测试不退化 | 4–6 周 |
| **T3** | **M2**：严格翻译、读写权限、单核过期 TLB | [C2.1](#case-c2-1)–[C2.4](#case-c2-4) 可运行 | 同上，加上星绽 ktest 中 mm 部分的误报统计 | 3–4 周 |
| **T4** | **M4**：AP 启动、per-CPU 重定位、迁移、IPI、跨核 TLB | [C4.1](#case-c4-1)–[C4.4](#case-c4-4) 可运行 | 同上 | 4–6 周 |
| **T5** | **BlueOS 迁移**：只做中断和任务切换，不做分页（BlueOS 目标配置是 `page_table=false`） | 同一套 M3 在 BlueOS 上跑通 | 统计改动量；做 C3 类的对照 | 3–4 周 |
| **P（并行）** | **挖真实 bug**：在星绽 git 历史里搜修复 irq、tlb、preempt、cpu_local、wake、race 的提交，挑能在 KMiri 里复现的 | 历史 bug 清单，标明各自依赖哪个机制 | 每条都有修复前和修复后两个版本 | 持续 |

**建议本周就开始的事：** 先做 T0 和 P。T0 能让下次组会拿出“现有 KMiri 在哪些案例上漏报或误报”的**实测表**，同时也是后续每个机制的验收用例。P 决定论文最后有没有说服力。

---

## 7. 组会上需要导师拍板的问题

1. **论文主线**是否定为“环境事件 bug”？BlueOS 那批容器类 UB（A 类）是否只作为工程成果，不计入方法贡献？
2. **和 KernMiri（ATC'25）的关系：** 是否同一团队的延续？这决定 M1 能不能写成“修正前作模型”，还是只能放进“实现细节”。
3. **首篇范围：** M1 + M2 + M3（单核）是否已经够投稿，M4 留到期刊或扩展版？还是一定要双核？
4. **第二个内核：** Codex 建议 BlueOS。本文同意，但建议只在 BlueOS 上验证 M3（中断加任务切换），不做分页。

---

## 附：术语速查

| 术语 | 一句话解释 |
|---|---|
| MIR | Rust 编译器的中间表示，Miri 解释执行它 |
| SB / TB | Stacked Borrows / Tree Borrows，Miri 检查借用规则的两种模型 |
| provenance | 指针“来自哪个对象”的记录；整数转回指针时会丢失，变成 wildcard |
| Mirch | KMiri 定义的伪 CPU 架构，内核为它写一个纯 Rust 的架构层 |
| shim | 由解释器直接实现的函数，内核调用它来通知事件 |
| typed / untyped 页 | 已声明存放 Rust 对象的页 / 只当字节用的页 |
| TLB | CPU 缓存的地址翻译；改页表后必须刷新，否则会继续用旧翻译 |
| IRQ / 中断上下文 | 硬件中断；中断处理器运行时所在的特殊执行环境，不能睡眠 |
| IPI | 一个 CPU 发给另一个 CPU 的中断，用于跨核唤醒、TLB shootdown |
| per-CPU / CPU-local | 每个 CPU 各有一份的数据 |
| AP | 启动后由主 CPU 唤醒的其他 CPU |
