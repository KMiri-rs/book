# KMiri 蓝图 v3：我们关注哪些 UB、为什么、中断支持到哪一步

> 2026-11-04 · 组会稿 v3，取代 v2（v1、v2 保留为同目录的 `BLUEPRINT-v1.md`、`BLUEPRINT-v2.md`）。
>
> **v3 改了什么：** v2 的 U1–U4 只有示意代码，也没说清“为什么是这几类”。v3 换了推理顺序：
>
> 1. 以星绽**官方 soundness 文档**对“UB 从哪里来”的定义为起点；
> 2. 用 2026 年 9 月星绽上报的 **30 个真实 soundness bug** 逐条分类，看实际分布；
> 3. 由分类结果推出关注范围，每一类都配**真实 issue** 的讲解。
>
> **证据等级：** 【已核对】直接读过 issue、PR 或文档原文；【初步分类】本文根据 issue 正文所做的归类，组会后应逐条复核；【设计】本文提出的方案，尚未实现。

---

## 0. 一页结论

**1. 关注什么。** KMiri 新论文关注的是**依赖“执行环境事件”的 UB**：中断状态、抢占、原子模式、跨 CPU 执行。共四类：

| 编号 | 类别 | 真实案例（星绽） | 后果 |
|---|---|---|---|
| **E1** | 中断开关状态失真，破坏安全前提 | #3896、#1120 | **Rust UB**（RCU 释放后使用） |
| **E2** | 原子模式被破坏：持自旋锁或关中断时睡眠、抢占计数失效 | #3895（UB）；#3965、#3157（3 处）、#3309、2026-11-04 新报的 6 个 | UB 或 panic、死锁 |
| **E3** | 中断上下文的锁使用错误 | #4147、#4148、#3102 | 单核永久死锁 |
| **E4** | 跨 CPU 的局部性破坏和数据竞争 | #3891、#3909、#3893 | **Rust UB**（数据竞争） |

**2. 为什么是这四类。** 星绽 OSTD 的 30 个真实 soundness bug 中，有 11 个位于与体系结构无关的代码，也就是 KMiri 能执行到的代码。这 11 个里：

- 6 个只依赖内存环境，前作 KernMiri 的机制已经覆盖；
- **5 个依赖中断、抢占或跨 CPU 事件**。现有任何工具都无法让这些事件在正确的时刻发生，这就是本文要补的部分。

其余 19 个分布在启动协议解析、陷入汇编、特定架构后端和设备 DMA 中。KMiri 用 Mirch 替换了架构层，**按设计就执行不到这些代码**，所以不作为主张。

**3. 为什么优先这几类（论文中的理由）：**

- **必要性：** 中断可以在任意两条指令之间到达，测试代码无法把处理器“插进”另一个函数的中途执行；用户态切换和系统调用则可以通过直接调用处理函数来复现。
- **承重性：** 星绽的 RCU 和 CPU-local 的健全性，都以“中断与原子模式状态正确”为前提。
- **普遍性：** 星绽 2026 年仍在持续出现这类 bug；Linux 中仅“原子上下文睡眠”一种，就有静态工具报出上千个真实 bug。
- **类型系统盲区：** Rust 的 `Send`/`Sync` 只描述线程，描述不了“同一 CPU 上被中断打断”这种关系。

**4. 用户态切换为什么首篇不做。** 扩大覆盖面当然好，我们也**要用系统调用作为负载**，把执行带到内核各处。但“真正执行用户态和特权切换”**不需要作为一个新机制**：

- 用户行为进入与架构无关的内核代码时，只表现为**数据**（参数、复制进来的字节），直接调用处理函数就能提供；
- 用户态触发的 4 个真实 UB 全部位于 LoongArch 的特定架构后端，KMiri 执行不到；
- 特权切换本身是汇编。

**5. 中断支持范围：**

- **必做：** 如实维护中断开关状态，以及定时器中断、上半部、下半部、中断返回时的抢占。
- **第二步：** 嵌套中断，以及触发任意已注册的中断线。
- **双核：** 真实案例显示 E4 的 3 个 UB 都需要两个任务真正并行，因此**双核应争取放进首篇**，作为第二个里程碑（理由见第 7 节）。

---

## 1. 背景速讲：读懂后文需要的五个概念

**中断（IRQ）。** 硬件（定时器、网卡、磁盘）通知 CPU“有事发生”。CPU 会在**当前代码的任意两条指令之间**停下，跳去执行中断处理函数，执行完再回来继续。被打断的代码对此毫无察觉。

**下半部（bottom half / softirq）。** 中断处理函数必须很短，较长的工作就推迟到“中断返回前”执行，这部分叫下半部。下半部同样会打断任务代码。

**原子模式（atomic mode）。** 星绽把“关了抢占”或“关了中断”的状态叫作原子模式。在原子模式里**不能睡眠**。原因是持着自旋锁睡下去后，同一 CPU 上的其他任务若也要这把锁，就会永远等下去。星绽在每次上下文切换前用 `might_sleep()` 检查这一点，违反就 panic。

**守卫（guard）。** 星绽用 RAII 对象表示原子模式：`disable_local()` 返回 `DisabledLocalIrqGuard`（中断已关），`disable_preempt()` 返回 `DisabledPreemptGuard`（抢占已关）。自旋锁在声明时选择“守卫种类”：
- `PreemptDisabled`：只关抢占；
- `LocalIrqDisabled`：关中断；
- `BottomHalfDisabled`：关下半部。

**如果一把锁会在中断或下半部里被获取，任务一侧就必须用能挡住它们的守卫。**

**RCU 和 CPU-local。** 两者都把守卫当作安全证明：
- **RCU** 中，读者持有守卫期间，写者不会回收旧数据。星绽判断“读者都离开了”的依据是“该 CPU 发生过一次上下文切换”。这个依据成立的前提是：在原子模式里不可能发生上下文切换。
- **CPU-local** 是每个 CPU 一份的数据，访问时要出示 `DisabledLocalIrqGuard`。它证明当前任务不会被中断打断，也不会被迁移到别的 CPU。

> 也就是说，**守卫所代表的中断和抢占状态必须与真实状态一致**，否则 RCU 和 CPU-local 的安全论证都会失效，结果就是真正的 Rust UB。

**KMiri 现状【已核对】**：星绽为 KMiri 写的架构层 `ostd/src/arch/miri/irq.rs` 中，`enable_local()`、`disable_local()` 是空函数，`is_local_enabled()` 恒返回 `true`，中断也从不到达。因此上面这些依赖中断状态的安全论证，在 KMiri 里**从未被检验过**。

---

## 2. 推导：我们应该关注哪些 UB

### 2.1 起点：星绽自己对“UB 从哪里来”的定义

星绽官方文档 [What Soundness Means](https://github.com/asterinas/asterinas/blob/main/book/src/ostd/soundness/what-soundness-means.md) 给出的 OSTD 健全性目标【已核对】：

> No sequence of calls to OSTD's safe public API — combined with any behavior from user-space programs and peripheral devices — from a client in safe Rust can trigger undefined behaviors (UBs).

文档列出四类**不受信任**的行为，OSTD 必须在它们的任意组合下保持健全：

1. `kernel/` 中的安全 Rust 代码，以任意顺序调用 OSTD 的安全 API；
2. 注入的策略（调度器、页分配器、slab 分配器），可能做出任意错误决定；
3. 用户程序：任意指令、任意系统调用、任意参数；
4. 外设：任意 DMA、**任意中断**、任意 MMIO 返回值。

**所以，一个 UB 在星绽中出现，意味着 OSTD 的 unsafe 代码在上述某种不受信任行为下没有守住不变量。** KMiri 的任务，就是在解释执行中**制造这些行为**，同时让 Miri 检查 OSTD 的 unsafe 代码有没有守住。

这就给出了一个与工具实现无关的问题：**四类不受信任行为中，哪些是现有手段制造不出来的？**

| 不受信任的行为 | 现有手段能否制造 | 说明 |
|---|---|---|
| ① 安全代码以任意顺序调用 API | **能**：ktest 和单元测试直接调用；KernMiri 已经能在内核内存模型下运行 | 前作覆盖 |
| ② 注入错误策略 | **能**：测试代码可以注入一个故意出错的调度器或分配器 | 不需要新机制 |
| ③ 用户程序 | **基本能**：见第 5 节。用户行为到达架构无关代码时只是数据，可以直接调用处理函数提供 | 不需要新机制 |
| ④a 外设 DMA、MMIO 数据 | 需要设备模型，并且依赖 IOMMU 配置 | 不在首篇范围 |
| **④b 外设在任意时刻中断** | **不能**：处理函数要在被打断函数的**中途**、在**同一 CPU 上**执行，测试代码做不到 | **本文核心** |
| **（④b 的后果）抢占、跨 CPU 迁移** | **不能**：ktest 没有控制 CPU 亲和性的手段（见 #3954 的 PR 说明） | **本文核心** |

### 2.2 实证：30 个真实 soundness bug 的分布

2026 年 9 月，有人用 AI 代码审查扫描星绽 OSTD，把**能从 OSTD 外部用安全代码触发**的 soundness bug 汇总在 [#3920](https://github.com/asterinas/asterinas/issues/3920)：共 30 个（#3881、#3882、#3891–#3918），截至今天 16 个已关闭、14 个仍开放。这是目前能拿到的、**最接近“星绽真实 UB 分布”的样本**。

我按“触发它需要什么”以及“KMiri 能否执行到这段代码”对这 30 个 bug 做了【初步分类】：

| 类别 | 数量 | issue | KMiri 能否执行到 |
|---|---|---|---|
| 启动协议、固件数据解析（Multiboot、PVH、Linux boot params、FDT、EFI） | 9 | #3899 #3900 #3901 #3913 #3914 #3915 #3916 #3917 #3918 | **不能**：KMiri 用 `miri_boot` 跳过真实启动路径 |
| 陷入入口汇编、NMI | 4 | #3904 #3906 #3907 #3908 | **不能**：汇编不是 MIR |
| 特定架构的用户内存后端（LoongArch） | 4 | #3881 #3882 #3902 #3903 | **不能**：KMiri 用 Mirch 替换了架构后端 |
| 特定架构的 MMIO 路径（x86） | 1 | #3894 | **不能**：同上 |
| 外设 DMA | 1 | #3905 | 需要设备模型 |
| **架构无关，只依赖内存环境或顺序调用** | **6** | #3892 #3897 #3898 #3910 #3911 #3912 | **能**：前作机制适用 |
| **架构无关，依赖中断、抢占或跨 CPU 事件** | **5** | **#3891 #3893 #3895 #3896 #3909** | **代码能执行到，但事件制造不出来** ← 本文 |

由此得到三点：

1. **KMiri 能执行到的部分，就是与架构无关的 11 个 bug。** 其中 6 个是内存环境类，KernMiri 已能处理；**另外 5 个（45%）都卡在执行环境事件上**。新论文的空白正好在这里。
2. 30 个里有 19 个位于 KMiri **按设计就执行不到**的代码：启动、汇编、特定架构后端、设备。这是 KMiri 方法的固有边界。它们应该用别的手段检查：解析器可以用普通 Miri 单元测试，汇编可以用 TickTock 那样的形式验证。论文要诚实写明这一点，而不是去追。
3. 用户态触发的 UB（#3881 等 4 个）**全部在 LoongArch 后端**。就算 KMiri 真的执行用户态，检查到的也是 Mirch 的后端，而不是 LoongArch 的。这就是首篇不做用户态切换的实证依据（第 5 节）。

> **注意：** 这 30 个 bug 是 AI 审查报出的，多数**没有实际运行过**（例如 #3895 原文写着 “It was not executed”）。这本身就是一个机会：KMiri 能给出**可运行、可重放的证据**（见第 6 节）。

### 2.3 还有一大类不是 UB 但同源的问题：中断和原子模式契约违反

除了上面的 UB，星绽 issue 里还有大量**同一根因**的 bug。它们的后果是死锁或 panic，不是内存 UB【已核对】：

| issue | 内容 | 状态 |
|---|---|---|
| [#4147](https://github.com/asterinas/asterinas/issues/4147) | 定时器中断与 `/proc/loadavg` 读者死锁 | 2026-11-04 修复（#4149） |
| [#4148](https://github.com/asterinas/asterinas/issues/4148) | vsock 接收软中断与 `bind`、`close` 死锁 | 2026-11-04 修复（#4149） |
| [#3102](https://github.com/asterinas/asterinas/issues/3102) | DMA 引用计数锁在软中断、硬中断里死锁 | 2026-04 修复 |
| [#3965](https://github.com/asterinas/asterinas/issues/3965) | UNIX 数据报 `bind` 持自旋锁时睡眠 | 2026-10 修复（#4074） |
| [#3157](https://github.com/asterinas/asterinas/issues/3157) | 3 处原子模式违反（vsock、Condvar） | 2026-04 关闭（#3309 等） |
| #4158 #4161 #4163 #4164 #4166 #4167 | 6 个新报的“持锁时睡眠” | **2026-11-04 新开，未修** |
| [#1120](https://github.com/asterinas/asterinas/issues/1120) | 乱序释放关中断锁，导致中断提前打开 | 2024 年起至今未修 |

把它们纳入范围的理由有两个：

- **同一根因、同一机制**：都是“代码对异步上下文的假设错了”，KMiri 用同一套中断和抢占模型就能触发并发现。
- 星绽把“原子模式里不能睡眠”列为**安全不变量**（文档 [Safe Kernel Logic](https://github.com/asterinas/asterinas/blob/main/book/src/ostd/soundness/safe-kernel-logic.md)），RCU 的健全性依赖它。一旦这个检查被绕过，后果就是 #3896 那样的 UAF（见 3.1）。

论文的**标题主张**仍是 UB；这类死锁和 panic 作为附加发现单独计数。是否这样处理，请导师决定（第 9 节）。

---

## 3. 关注的四类：讲解与真实案例

### E1 中断开关状态失真，破坏安全前提（Rust UB）

**是什么：** 代码以为中断是关着的（手里还拿着关中断守卫），实际上中断已经被打开了。所有以“中断已关”为前提的安全论证都随之失效。

**真实案例 [#3896](https://github.com/asterinas/asterinas/issues/3896)（2026-09 报告并修复，单核）【已核对】：**

1. `disable_local()` 的实现：每个守卫只记一个布尔值“我创建时中断是不是开着的”。如果是，`drop` 时就打开中断。
2. 嵌套使用时：外层守卫 A 创建时中断开着（记 `true`），内层守卫 B 创建时中断已关（记 `false`）。
3. 如果**先释放 A、后释放 B**，A 被释放的那一刻中断就打开了，**B 还活着**。
4. B 被当作“处于原子模式”的证据交给 `Rcu::read_with`，得到一个指向 RCU 数据的引用。
5. 接着发生上下文切换：`might_sleep()` 看到抢占计数为 0、中断开着，判定允许切换，RCU 随即认为“这个 CPU 已经离开读临界区”。单核时宽限期立即结束，旧数据被**释放**。
6. 那个引用还在使用 → **释放后使用（UAF）**。

同一类问题早在 2024 年就有人报过：[#1120](https://github.com/asterinas/asterinas/issues/1120) 描述了乱序释放两把关中断锁会导致中断提前打开，至今仍未关闭。Rust-for-Linux 的 `SpinLockIrq` 补丁系列从 2024 年起修订到 v19（2026-03），争论的核心之一也正是“关中断守卫在乱序释放、被复制时如何保持健全”（见 [v19 补丁](https://lkml.iu.edu/2603.0/03004.html)、[v16 系列](https://lkml.iu.edu/2512.1/04438.html)）。**可见这不是星绽一家的偶发问题。**

**为什么现有手段抓不到：**
- 原生运行时，乱序释放只是让中断提前打开，要等到之后恰好发生一次切换、并且读者恰好还在用引用，才会出问题。即便出了问题也只是静默损坏。
- 普通 Miri 不执行内核。
- 现有 KMiri 中 `enable_local()` 是空函数，`is_local_enabled()` 恒为真，**“中断被提前打开”这件事根本不存在**。

**KMiri 需要什么：** 解释器如实维护每个 CPU 的中断开关状态（不需要真的投递中断）。之后按 issue 的步骤执行，RCU 回收后的访问会由 Miri 的 UAF 检查报出。

### E2 原子模式被破坏（UB，或 panic、死锁）

**是什么：** 在“不允许睡眠或切换”的状态下发生了睡眠或切换，或者用来判断这个状态的计数本身出了错。

**真实案例 [#3895](https://github.com/asterinas/asterinas/issues/3895)（UB，单核，仍未修复）【已核对】：** 抢占计数和另一个标志位被打包在一个 32 位字里，计数只占 31 位，自增时没有溢出检查。计数一旦回绕到 0，`might_sleep()` 就认为当前不在原子模式，允许切换，RCU 宽限期提前结束，持有中的 RCU 引用变成 UAF。

**真实案例 [#3965](https://github.com/asterinas/asterinas/issues/3965)（panic，已修复）【已核对】：** `bind` 持着自旋锁去创建 socket 文件，途中要拿文件系统的睡眠锁。**只有在睡眠锁正好被别人持有时**才会真的睡下去并触发 panic，所以 issue 作者需要两个线程不停地 `bind` 来制造争用。[#3157](https://github.com/asterinas/asterinas/issues/3157)、[#3309](https://github.com/asterinas/asterinas/pull/3309) 也是同一模式：`Condvar::wait_timeout` 只在“超时”分支、并且互斥锁正好被争用时才会出错。

**为什么现有手段抓不到：** 这类 bug 要求“恰好有争用”或“恰好在某个时刻切换”，原生测试只能靠压力和运气。

**KMiri 需要什么：**
- 如实的中断状态，让 `might_sleep()` 的判断真正生效；
- **抢占注入**：在持锁区间里注入定时器中断并触发抢占，把另一个任务调度进来争同一把锁，从而确定性地制造出“恰好有争用”。

这样 #3965 一类问题就由星绽**自带**的 `might_sleep()` 报出，而且可以重放。

### E3 中断上下文的锁使用错误（单核死锁）

**是什么：** 一把锁既在中断（或下半部）里被获取，又在任务里以“没关中断”的方式持有。中断恰好在任务持锁时到达，处理函数就会去等这把锁。可是持锁者正是被它打断的那个任务，必须等处理函数返回才能继续，于是**同一个 CPU 永远卡在中断里**。

**真实案例 [#4147](https://github.com/asterinas/asterinas/issues/4147)（2026-11-04 修复）【已核对】：**

```
任务上下文（中断开着）:  sysinfo() → get_loadavg() → LOAD_AVG.read()     // RwLock<PreemptDisabled>：只关抢占
定时器中断（约每 5 秒）:  timer_callback → update_loadavg → LOAD_AVG.write() // 等读者释放，但读者已被中断挂起
```

issue 作者的复现方式是：用户程序不停调用 `sysinfo()`，**4 台单核虚拟机分别在 35 到 306 秒之后死锁**，再用 GDB 看到 CPU 卡在中断里的 `LOAD_AVG.write()` 上。修复（[#4149](https://github.com/asterinas/asterinas/pull/4149)）只是把守卫换成 `LocalIrqDisabled`。

[#4148](https://github.com/asterinas/asterinas/issues/4148) 是下半部版本：vsock 的端口表锁用了 `PreemptDisabled`，但接收软中断也会拿它。复现需要宿主机持续发起 vsock 连接，并且碰巧在客户机持锁时到达。

**为什么现有手段抓不到：** 原生测试要等几十到几百秒的随机窗口；ktest 无法“在持锁时来一次中断”；普通 Miri 和现有 KMiri 都没有中断。

**KMiri 需要什么：**
- 在持锁区间里**按需注入**定时器中断或下半部，执行真实的 `timer_callback`；
- **中断上下文死锁诊断**：中断处理函数等待的锁，如果由被它打断的同 CPU 执行流持有，就立即报告，并附上两侧的调用栈和可重放的注入轨迹。

> **要诚实写明：** Linux 的 lockdep 不需要真的撞上窗口，只要分别观察到“这把锁在中断里用过”和“这把锁在任务里没关中断就用过”，就能报出这类问题。星绽也可以实现类似的原生检查。KMiri 的增量在于：同一次运行中还能检查 E1、E2、E4 的 UB，并给出确定性的执行轨迹。论文里应当讨论这一点，而不是宣称“只有 KMiri 能发现 E3”。

### E4 跨 CPU 的局部性破坏和数据竞争（Rust UB）

**是什么：** 某个只对“当前 CPU”成立的证明（守卫）、或者每个 CPU 一份的数据，被带到了另一个 CPU 上使用；或者两个任务在两个 CPU 上同时、无同步地访问同一数据。

**真实案例 [#3891](https://github.com/asterinas/asterinas/issues/3891)（2026-09 报告，#3954 修复）【已核对】：** 关中断守卫是 `!Send` 但是 `Sync`，所以它的**引用**可以被别的任务捕获。别的任务被调度到 CPU B 后，拿着 CPU A 的守卫引用去访问 CPU-local 数据，就和 CPU A 上的合法访问者形成**数据竞争**。修复 PR [#3954](https://github.com/asterinas/asterinas/pull/3954) 的作者明确写道：

> A deterministic runtime test for the cross-CPU panic path is not included because **ktest provides no CPU-affinity control** to place a task on a specific remote CPU.

**这句话本身就说明了 KMiri 的必要性**：星绽现有的测试框架无法为这个 bug 写出回归测试。

[#3909](https://github.com/asterinas/asterinas/issues/3909)（自定义锁守卫导致跨 CPU 数据竞争）和 [#3893](https://github.com/asterinas/asterinas/issues/3893)（两个任务在两个 CPU 上同时写同一个 untyped 帧）同属此类。issue 原文都写明需要 “at least two CPUs”。

**为什么现有手段抓不到：** 需要真正并行的两个任务，并且要精确控制在哪个 CPU 上运行。现有 KMiri 星绽端只跑 1 个 CPU；即使有 2 个，任务切换也都要经过调度器的锁，Miri 的向量时钟会因此记下 happens-before，**把真实的竞争掩盖掉**。

**KMiri 需要什么：**
- 真实启动第二个 CPU；
- per-CPU 地址重定位（现在两个 CPU 共用一份 CPU-local）；
- 可控的任务迁移和放置；
- 抢占式切换**不产生**额外的 happens-before。

之后由 Miri 现有的数据竞争检测报出。

---

## 4. 四类之外：不关注什么，各自的理由

| 不关注的类别 | 真实样本 | 理由 |
|---|---|---|
| 启动协议、固件数据解析 | 9 / 30 | KMiri 用 `miri_boot` 跳过真实启动。这些解析器是纯顺序代码，**普通 Miri 配上构造的启动数据做单元测试就能查**，不需要内核环境 |
| 陷入汇编、NMI 与 `swapgs` 窗口 | 4 / 30 | 汇编不是 MIR，解释器原理上执行不到。需要形式验证这类手段（例如 TickTock 对 ARMv7-M 汇编的处理） |
| 特定架构后端（LoongArch 用户复制、x86 MMIO） | 5 / 30 | KMiri 把架构层替换成 Mirch，检查到的是 Mirch 的实现，不是被测架构的实现 |
| 设备 DMA | 1 / 30 | 需要设备模型，而且依赖是否启用 IOMMU；不在首篇范围 |
| 只依赖内存环境或顺序调用的 UB | 6 / 30 | **不是不关心，而是前作已有机制。** 评测中会作为对照和回归集，但不算新贡献 |
| KMiri 自身的建模 bug（对象复活漏报、分配器回收误报等） | — | 我们自己工具的问题，作为前置工程修复，不计贡献（第 8 节） |
| 纯逻辑错误（不构成 UB、也不违反安全不变量） | — | 没有可靠的检查依据 |

---

## 5. 用户态切换：完整的论证

你问得对：“扩大覆盖面”本身是好事，不能拿来当作不做的理由。准确的说法应该是：

> **用户态带来的覆盖面，不需要新的解释器机制就能获得；需要新机制才能检查的那部分，KMiri 按设计执行不到。**

具体分四点。

**（1）区分“怎么到达代码”和“什么事件触发 bug”。** 前面的真实 bug 几乎都是**从系统调用出发**到达出错代码的：#4147 从 `sysinfo()` 出发，#3965 从 `bind()` 出发。所以系统调用作为**负载**是必须的，我们会用。但触发 bug 的是**中断和抢占**。负载要用，但它不是新机制，也不是论文主张。

**（2）用户行为到达架构无关代码时，只是数据。** 星绽规定内核**从不创建指向用户内存的 Rust 引用**，只通过 `VmReader<Fallible>`、`VmWriter<Fallible>` 这类原始指针接口复制（见官方文档 [Safe User-Kernel Interactions](https://github.com/asterinas/asterinas/blob/main/book/src/ostd/soundness/safe-user-kernel-interactions.md)【已核对】）。因此用户程序**无法通过并发修改自己的内存，在架构无关代码里制造 Rust 别名冲突**。它能影响的只有系统调用参数和复制进来的字节，测试代码直接调用处理函数就能提供这些值，KMiri 现有能力已经可以执行。

**（3）同步与异步的本质区别。** 系统调用发生在**确定的位置**：用户执行 `syscall` 指令时，进入内核后是一段顺序执行。只要“构造好寄存器，然后调用处理函数”，就能等价复现。中断则可以落在内核代码**任意两条指令之间**。测试代码无法把处理函数插进另一个函数的中途，这件事只能由解释器来做。**判断标准是：这种环境行为能否不靠解释器支持就被复现。** 用户态能，中断不能。

**（4）实证。** 30 个 bug 里由用户程序触发的 4 个（#3881、#3882、#3902、#3903）都在 **LoongArch 特定的用户内存复制后端**：它对可能缺页的地址用了 `ptr::copy`。即使 KMiri 完整模拟用户态，执行的也是 Mirch 的复制后端，而不是 LoongArch 的，**照样查不到**。

**一个低成本的例外（建议做，但算工程）：** “复制用户内存时，任意一个字节都可能缺页失败”这个语义与架构无关。可以在 Mirch 的 `kern_miri_copy`（目前未实现）里让复制随机在某个偏移处失败，检查调用者的错误处理。这只需要改一个 shim，不需要执行用户态。

**以后可以扩展：** 星绽 Miri 版的 `UserContext::execute` 已经是“`run()` 之后按陷入号分派”的结构【已核对】。以后让 `run()` 按脚本返回一个合成的系统调用，就能把整条“用户请求 → 内核处理”路径接进来。写进 Future Work。

---

## 6. 为什么优先这几类（论文中可以写的理由）

| 理由 | 依据 |
|---|---|
| **必要性：** 这是唯一一类“现有任何工具都制造不出触发条件”的 UB | #3954 作者说 ktest 无法控制 CPU 亲和性；#4147 原生要 35–306 秒随机触发；Miri、KernMiri、Loom、Miri-GenMC 都没有中断语义 |
| **承重性：** 一旦出错，击穿的是内核核心的健全性论证，而不是某个驱动 | 星绽 RCU 和 CPU-local 的安全论证都以中断和原子模式状态为前提（官方 soundness 文档）；#3895、#3896 直接导致 RCU UAF |
| **普遍性：** 不是个例，而且持续出现 | 星绽：真实 UB 样本中占架构无关部分的 5/11；2026 年至少 10 个中断或原子模式相关的死锁、panic issue，其中 6 个今天新开。Linux：DSAC 在 Linux 4.17 报出 1159 个“原子上下文睡眠”bug，人工确认 1068 个真实（[TOCS 2020](https://hal.archives-ouvertes.fr/hal-03032244)）；ATC'18 版本在内核模块中发现 401 个新 bug（[ATC'18](https://www.usenix.org/conference/atc18/presentation/bai)） |
| **类型系统盲区：** Rust 帮不上忙 | `Send`/`Sync` 只描述线程之间的关系；中断处理函数与被打断代码在**同一 CPU、同一执行流**上，Rust 类型系统无法表达“中断安全”，只能靠守卫约定。而守卫的设计本身就一再出错：#1120、#3891、#3896、#3909，以及 RFL `SpinLockIrq` 修订了 19 版 |

另外，Rust-for-Linux 第一个 CVE（[CVE-2025-68260](https://nvd.nist.gov/vuln/detail/cve-2025-68260)，Rust Binder）是 unsafe 链表上的**跨线程竞争**，导致内存损坏，属于 E4 同类问题。这说明这类问题在 Linux 的 Rust 代码中同样存在。

**不能写的理由：** “因为好实现”。另外，“首个把 Rust UB 检查带进内核”也不能写，前作已经做过。

---

## 7. 对评测和 baseline 的影响

上一轮的结论保留：主实验是“KMiri 事件模型关闭（约等于 KernMiri）”与“完整 KMiri”的消融；“普通 Miri 单元测试”和“原生 QEMU 多次运行”说明现状；KASAN 只做能力对比。v3 新增三点：

1. **现成的 benchmark。** #3920 的 30 个 bug 就是一份带客观分母的真实 UB 集合。对其中 11 个架构无关的 bug，分别在“事件关”和“完整”两种配置下检查，预期是：事件关时 6 个内存类可检出、5 个事件类检不出；完整时 5 个事件类也能检出。再加上 2.3 节的死锁和睡眠 issue，并与它们的**原生复现时间**比较（#4147：35–306 秒）。
2. **新的竞品：AI 代码审查。** 这 30 个 bug 是 LLM 静态审查找到的，多数没有运行验证。KMiri 与它是互补关系：KMiri 能把“源码推理出的反例”变成**可运行、可重放的执行证据**，从而区分真问题和误判。论文可以把“为 AI 报告提供动态确认”作为一项评测：AI 报告了多少，KMiri 确认了多少、否定了多少。
3. **双核要争取进首篇。** 5 个事件类 UB 中，#3895、#3896 是单核；**#3891、#3909、#3893 都需要两个 CPU 真正并行**。只做单核，最有说服力的真实 UB 案例会少一半以上。建议顺序：单核中断状态和抢占（E1、E2、E3）先行，双核（E4）作为首篇的第二个里程碑；如果双核赶不上，论文只主张 E1–E3，E4 列为限制。

---

## 8. 中断支持范围（结论，与 v2 基本一致）

| 版本 | 内容 | 对应类别 |
|---|---|---|
| **v1（必做）** | 每个 CPU 的中断开关状态由解释器维护（不投递中断就已能覆盖 #3896 一类）；虚拟时间驱动的定时器；在中断打开时于 MIR 语句边界注入（用种子控制、有次数上限、可记录重放）；在被打断的线程上嵌套执行**真实的**上半部和下半部；中断返回时的抢占；中断上下文死锁诊断 | E1、E2、E3 |
| **v2** | 嵌套中断（OSTD 支持两级）；触发任意已注册的中断线（不做设备模型）；对指定区间做有界枚举 | E1、E3 在下半部和嵌套边界上的情形 |
| **v3（首篇第二个里程碑）** | 真实启动第二个 CPU、per-CPU 地址重定位、可控迁移和放置、IPI；抢占式切换不产生 happens-before | E4 |
| 不做 | 真实用户态执行、特权切换汇编、NMI、设备 DMA | 理由见第 4、5 节 |

**前置工程（不计贡献）：** 修 KMiri 自身的已知问题。其中“已释放对象被复活”的漏报（RFL #1261、miri#64）会挡住 RCU UAF（#3895、#3896）的检出，**必须在 E1、E2 实验之前修好**。

---

## 9. 下一步

| 序号 | 任务 | 产出 |
|---|---|---|
| **T0** | 逐条复核第 2.2 节的 30 个 bug 分类（本文是初步分类） | 定稿的分类表，作为论文的 motivation 数据 |
| **T1** | 先在**现有 KMiri** 上复现 6 个内存类 bug（#3892 #3897 #3898 #3910 #3911 #3912） | 验证前作机制的能力，形成消融基线的第一列 |
| **T2** | 把 5 个事件类 bug 和 #4147、#4148、#3965 写成 KMiri 测试内核（使用 issue 中的修复前版本，加上修复后版本作为对照） | 在现有 KMiri 上运行，预期全部“检不出或执行不到”，作为改进前的证据 |
| **T3** | 前置工程：修复对象复活漏报 | PR 和回归测试 |
| **T4** | 中断 v1 | 验收标准：T2 中的 E1、E2、E3 用例在缺陷版本上检出、在修复版本上通过，并且可重放 |
| **T5** | 双核 v3 | E4 用例检出 |

**需要导师拍板：**

1. 论文主张是否定为“依赖执行环境事件的 UB”（E1–E4），死锁和 panic 类（2.3 节）作为附加发现？
2. 双核是否放进首篇（建议争取，理由见第 7 节）？
3. 是否把“为 AI 审查报告提供动态确认”作为一项评测？
4. BlueOS 的定位：v2 的建议（只做任务切换和中断）不变，但目前没有 BlueOS 侧的同类真实 bug 数据。建议先统计 BlueOS 的中断和锁相关 issue，再决定投入多少。

---

## 参考来源

- 星绽 soundness 文档：[what-soundness-means](https://github.com/asterinas/asterinas/blob/main/book/src/ostd/soundness/what-soundness-means.md)、[safe-kernel-logic](https://github.com/asterinas/asterinas/blob/main/book/src/ostd/soundness/safe-kernel-logic.md)、[safe-user-kernel-interactions](https://github.com/asterinas/asterinas/blob/main/book/src/ostd/soundness/safe-user-kernel-interactions.md)
- 星绽 issue 和 PR：[#3920 汇总](https://github.com/asterinas/asterinas/issues/3920)、[#3891](https://github.com/asterinas/asterinas/issues/3891)、[#3893](https://github.com/asterinas/asterinas/issues/3893)、[#3895](https://github.com/asterinas/asterinas/issues/3895)、[#3896](https://github.com/asterinas/asterinas/issues/3896)、[#3909](https://github.com/asterinas/asterinas/issues/3909)、[#3954](https://github.com/asterinas/asterinas/pull/3954)、[#4147](https://github.com/asterinas/asterinas/issues/4147)、[#4148](https://github.com/asterinas/asterinas/issues/4148)、[#4149](https://github.com/asterinas/asterinas/pull/4149)、[#3102](https://github.com/asterinas/asterinas/issues/3102)、[#3965](https://github.com/asterinas/asterinas/issues/3965)、[#3157](https://github.com/asterinas/asterinas/issues/3157)、[#3309](https://github.com/asterinas/asterinas/pull/3309)、[#1120](https://github.com/asterinas/asterinas/issues/1120)、[#925](https://github.com/asterinas/asterinas/pull/925)
- Linux：DSAC [ATC'18](https://www.usenix.org/conference/atc18/presentation/bai)、[TOCS 2020](https://hal.archives-ouvertes.fr/hal-03032244)；RFL `SpinLockIrq` [v16](https://lkml.iu.edu/2512.1/04438.html)、[v19](https://lkml.iu.edu/2603.0/03004.html)；[CVE-2025-68260](https://nvd.nist.gov/vuln/detail/cve-2025-68260)
