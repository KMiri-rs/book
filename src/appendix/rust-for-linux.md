# Rust for Linux 测试

本文归纳 KMiri 运行 Rust for Linux（RFL）测试的几条路径。PR 列表根据 GitHub 实际 PR 代码和状态整理；讨论 [#291][discussion-291]、[#293][discussion-293]、[#295][discussion-295]、[#296][discussion-296]、[#314][discussion-314] 用来补充背景、实验记录和思路。讨论中的方案不自动视为已合并实现。信息于 2026-11-08 查询。

## 先按测试对象分类

### 内核 Rust 的 `#[test]` 单元测试

Linux [#1][linux-1] 在内核 `kbuild` 中增加 Miri 测试目标，编译 `rust/kernel` 测试 crate，并将测试函数交给 KMiri 执行。bitmap 是第一批目标：复用 Linux 原有的六个 `KUnit` 测试，分别覆盖借用、复制、置位清位与查找、向量构造和越界输入：

- `bitmap_borrow`
- `bitmap_copy`
- `bitmap_copy_and_extend`
- `bitmap_set_clear_find`
- `bitmap_vec_new`
- `owned_bitmap_out_of_bounds`

`MIRI_TEST` 可用于名称过滤，但应检查输出确实有 `running 1 test` 或预期的测试数；过滤到零项的命令也可能返回成功。单测构建入口和可执行行为由 `makefile.local` 与 `kbuild` 连接，Miri 运行在宿主侧。

### 内核 `doctest`

Linux [#2][linux-2] 处理的是另一类测试。RFL `doctest` 通常通过 `KUnit` 生成和执行，不是直接把原始 markdown 当作普通 Rust `doctest` 交给 Miri。该 PR 新增 `rustdoc_test_gen_miri.rs`，从 `rustdoc` 生成的测试体重新组装 Miri 测试文件，为缺失的 `rust_helper_*`、引用计数和模块元数据提供纯 Rust `shim`，并接入独立的 `doctest` 构建目标。

PR 记录 352 个 `doctest` 中 261 个通过，约 74%；约 91 项因当时 KMiri 不能处理的能力被显式跳过。快速目标可以跳过完整 `kbuild`，直接重跑生成的测试文件。该数字是 PR 中的记录，不表示所有当前 RFL `doctest` 都已支持。

### 针对内核缺陷的单测复现

Linux [#5][linux-5]、[#6][linux-6]、[#7][linux-7] 也是 `#[test]`，但目标是把具体漏洞路径收进内核 Rust crate 测试：`Formatter` 悬垂写、`copy_from_iter_raw` 返回悬垂切片、`drm::device::Device::new` 初始化失败时重复 drop。它们分别通过 Miri `shim`、范围有限的外部函数替身或测试模块中的 C stand-in 处理外部依赖。报告 UB、测试通过和测试未选中是三种不同结果，不能把空测试集当作通过证据。

## Bitmap 单测：一条 RPC 路径和三种 Rust 化路径

bitmap 的核心障碍是 Rust wrapper 会经 `bindings` 调用 Linux C 函数。现有代码探索了两类思路：把所需 C 行为变成 Miri 可执行的 Rust 代码；或让 Miri 把指定调用交给 UML 内核实现。Rust 化有三种做法，但它们的输入、保真度和改动位置不同。

### 路径 A：AI 直接翻译/改写成 Miri 专用 Rust

Linux [#1][linux-1] 的实际代码在 `bitmap.rs` 中加 `cfg(miri)` 分支：分配改用 `Box<[usize]>`，并用 Rust 切片、位运算和循环实现测试所需的置位、清位、复制和查找；非 Miri 构建仍走 `bindings`。测试由此能运行，而不需要解释那些外部 C 符号。

这是最短的起步路径，适合验证 Rust wrapper 和测试入口。它运行的是分离出来的 Miri 专用实现，不会经过 bitmap 的原 `bindings` 路径，也不能单独证明 Linux C 实现的行为。PR diff 能确认这种双路径实现，但不能从代码本身确认具体由何种 AI 工具生成。

### 路径 B：AI 辅助整理最小 C 文件，再用 `C2Rust` 翻译

Linux [#4][linux-4] 增加 `bitmap_c2rust.rs`、条件编译接线和 `gen_c2rust_binding.sh`。脚本将一个最小 C 文件交给 `C2Rust`，做少量生成结果规范化，然后编入 RFL bitmap 测试构建。`KMIRI_BITMAP_C2RUST` 下 `bitmap.rs` 的 Miri 分支直接调用转译模块中的 Rust 函数；非 Miri 路径仍使用原有 `bindings`。也就是说，Miri 运行时不再调用这些 C binding。Miri [#68][miri-68] 为生成代码可能引用的 libc 符号别名增加 `shim`。

这里需要以提交的 C 模板为准：`tools/c2rust/templates/bitmap_uml_libc.c` 的注释明确说明，它是为 `C2Rust` 准备的手写最小 C 闭包，不是某个 Linux C 源文件的直接副本。它从 bitmap 测试依赖出发，挑出分配、置位清位、查找和复制行为，再用 `calloc`、`free`、`memcpy`、`memset` 作为边界。AI 可辅助整理这个闭包，但 PR 实际交付的是该 C 输入、转译脚本和生成的 Rust 文件。

该路径让同一组 bitmap tests 调用独立于 `bitmap.rs` 手写 miri 分支的代码。不过算法输入是精简后的 C 实现，不应描述成对整个 Linux bitmap 实现的自动翻译。PR [#4][linux-4] 报告关闭 Stacked Borrows 后六项通过，默认 Stacked Borrows 下 `bitmap_borrow` 报 UB；PR 仍开放。Miri [#68][miri-68] 也仍开放。

### 路径 C：以 `C2Rust` 转译 Linux 原始 C 为主，AI 协助处理转译障碍

Discussion [#295][discussion-295] 记录了更靠近真实源码的一次独立实验：以 Linux `lib/find_bit.c` 和 bitmap/bitops helper 为输入，通过 UML 构建取到匹配的 `clang` 编译参数，再用 `C2Rust` 生成 Rust 库，最后把 RFL 调用接回原 `bindings`。原始输入覆盖真实内核查找和非原子位操作，不是路径 B 那种人工缩小后的替代实现。

这次实验也记录了翻译工具和产物仍需处理：原版 `C2Rust` 的 AST 导出不能直接完成，实验修改了 `AstExporter`；生成代码还需补回 `sz` 等内容、处理汇编实现和 helper 依赖。部分函数由人工按通用算法替换或适配，因此结果不是“未经修改的自动翻译”。实验范围不包含原子操作；分配仍使用已有 `Box` 路径。

该实验对六个原有 bitmap 测试的记录是：Tree Borrows 和关闭 Stacked Borrows 时六项通过；默认 Stacked Borrows 下逐项运行有五项触发 `zero-size retag` 相关 UB。讨论还用纯 Rust 指针探针观察到同类错误，因此不能仅凭报错位于生成文件就归因于 `C2Rust`，也不能据此断言翻译正确或 RFL bitmap 已被证明有 soundness bug。扩展矩阵测试另有资源耗尽问题，不属于六项原始测试结果。此路径是讨论中的实验，不是 Linux [#4][linux-4] 已合并代码。

以上三种 AI 工作流名称用于区分实施方法。代码核对能确认具体产物和改动：Linux [#1][linux-1] 是 `cfg(miri)` Rust 实现；Linux [#4][linux-4] 的 C 模板注明为手写最小闭包；Discussion [#295][discussion-295] 记录了 `C2Rust` 导出器和生成物的具体人工修改，但没有逐项记录哪些问题由 AI 提出。因此不要把“AI 参与”误写成 PR 中可由代码独立验证的事实。

### 路径 D：通过 UML RPC 运行内核 bitmap 函数

Linux [#3][linux-3] 与 Miri [#67][miri-67] 实现了另一类方案：Miri 在解释 `foreign item` 时，将支持的 bitmap 调用转成请求，UML 内核中的 `KMiri passthrough helper` 通过 `/proc/kmiri_pt` 执行对应 Linux 函数。`hostfs` 共享目录承担 Miri 进程与 UML 进程间的请求响应传输；Linux 侧目标会配置、构建 UML helper、启动内核并运行 bitmap 单测。

代码边界比“把整个 Miri 进程放进内核”窄。Miri `shim` 仍在解释器内创建和释放 bitmap 的影子分配；对置位、清位、查找和 `copy_and_extend` 等操作，`shim` 从解释器内存读取位图字节，编码后发给 UML，拿回返回值或修改后的字节，再写回解释器内存。UML helper 调用内核 `bitmap/find` 函数。这样 Miri 仍能跟踪测试持有的分配和读写，但不会检查 RPC 调用内部的 C 执行、C 内部指针操作或原子行为本身。

讨论 [#291][discussion-291] 曾将“黑盒直通”作为一个可行但有漏报风险的思路；最终 Linux [#3][linux-3] 和 Miri [#67][miri-67] 给出了可运行的具体实现。讨论提醒的核心限制仍适用：跨进程传输会把部分别名、生命周期和内部内存语义藏在黑盒中；应明确标记为 `passthrough`，不能把这种路径的通过说成 Miri 检查了内核 C 实现的 UB。Linux [#3][linux-3] 记录六个 bitmap 单测通过，使用过关闭 Stacked Borrows 的设置。

## 几种 bitmap 路径的取舍

| 路径 | 测试实际经过什么 | 适合回答的问题 | 主要边界 |
|---|---|---|---|
| A：直接 Rust 改写 | `bitmap.rs` 的 `cfg(miri)` Rust 逻辑 | Rust wrapper、状态转换和测试入口是否可运行 | 绕过原 `bindings` 和 C 算法 |
| B：精简 C + `C2Rust` | 人工整理的最小 C 闭包转成 Rust | 选定的算法可否以生成 Rust 形式交给 Miri | 输入不是 Linux 原始完整实现；生成物需适配 |
| C：真实 Linux C + `C2Rust` | Linux C 源码及 helper 的转译/修补结果 | 真实源码路径在限定配置下能否转成 Miri 可执行 Rust | AST/汇编/宏适配仍需人工；实验范围有限；借用模型问题未解决 |
| D：UML RPC | 指定 bitmap C 函数在 UML 中运行，数据经 RPC 往返 | Linux 内核实现对给定位图数据的函数结果 | 调用内部是黑盒，Miri 不检查其中的 UB、指针或并发语义 |

这四条路径不能只按“测试绿了多少”排序。路径 A 测到的是 Rust 专用替代逻辑；路径 B/C 测到转译后的 Rust；路径 D 将函数内部交给内核执行。报告测试结果时应说明采用哪条路径、实际执行的测试数、`MIRI_FLAGS` 和被替代或旁路的代码边界。

## 分配和 UML 语义补充

Discussion [#296][discussion-296] 澄清，RFL 的 `KBox` 使用 `Kmalloc`，走 `krealloc_node_align`；UML 下 `kmalloc` 最终仍是内核分配器逻辑，不等同于 Rust 直接调用宿主 libc。路径 B 的 `bitmap_zalloc` 闭包使用 `calloc/free`，是为这段 bitmap 算法选择的测试边界，不代表 `KBox` 或所有 RFL 分配都被 libc 替代。Miri [#64][miri-64] 提供基本 `krealloc` `shim`，Miri [#71][miri-71] 则进一步完善对齐和零初始化语义。

Discussion [#293][discussion-293] 讨论了更广的 Rust abstraction、后端和逐步 Rust 化规划。它属于设计建议，并非上述 Linux PR 已实现的分层架构。Discussion [#314][discussion-314] 展示了另一种针对单个 `#[test]` 的方法：在 DRM 测试模块内提供五个 `#[no_mangle]` C 函数，模拟容器分配/释放，再让真实 Rust `release` 回调运行；失败、修复和成功控制组成对照。该例无需启动 UML，也无需为所有 DRM `bindings` 编写通用 `shim`。

## linux 仓库 PR 清单

查询到 KMiri-rs/linux 共 7 个 PR，目标分支均为 kmiri。

| PR | 状态 | 内容 |
|---|---|---|
| [#1：在 Miri 上运行 RFL 内核单测][linux-1] | 已合并 | `kbuild` 接入 Miri 单测；bitmap 六项测试使用 `cfg(miri)` Rust 实现。 |
| [#2：在 Miri 上运行 RFL `doctest`][linux-2] | 已合并 | 生成并运行 `doctest` 测试体，添加纯 Rust `shims`；记录 261/352 通过。 |
| [#3：增加 UML kmiri bitmap 透传][linux-3] | 已合并 | UML helper 和 `hostfs` 请求响应桥，供 bitmap 调用透传。 |
| [#4：经 `C2Rust` 路径运行 bitmap 单测][linux-4] | 开放 | 精简 C 闭包、`C2Rust` 生成物和独立测试目标。 |
| [#5：增加 `str::formatter_new_uaf` 用例][linux-5] | 已合并 | 复现 `Formatter` 悬垂写。 |
| [#6：增加 `copy_from_iter_raw` UAF 复现][linux-6] | 开放 | 释放输出缓冲区后读取返回切片；依赖 Miri [#73][miri-73] 的最小 `shim`。 |
| [#7：增加 `drm::device::Device::new` double-drop 复现][linux-7] | 开放 | 测试模块提供局部 C stand-in，验证初始化失败时的重复 drop。 |

## KMiri Miri 相关 PR 清单

以下为用户指定的五个 Miri PR，状态为 2026-11-08 查询结果。

| PR | 状态 | 支持内容 |
|---|---|---|
| [#64：支持 `krealloc_node_align` 并修正页表 slot 默认状态][miri-64] | 已合并 | 支持 RFL `Kmalloc`/KVec 路径；调整懒分配页表行为，避免已释放地址被解释为可新分配 slot。 |
| [#67：增加 bitmap `passthrough` `shim`][miri-67] | 已合并 | foreign-item `shim`、内存快照序列化和请求响应传输，对应 Linux [#3][linux-3]。 |
| [#68：支持 `C2Rust` bitmap runtime 的 libc 符号别名][miri-68] | 开放 | 支持 `__libc_malloc`、`__GI_memcpy`、`__builtin_memset` 等符号名，对应 Linux [#4][linux-4]。 |
| [#71：krealloc `shim` 遵循对齐和 `__GFP_ZERO`][miri-71] | 开放 | 补充分配器对齐、零初始化和增长语义及回归测试。 |
| [#73：为 RFL #1265 复现添加 `_copy_from_iter` `shim`][miri-73] | 开放 | 仅为复现提供单字节行为，不等同 Linux 的完整 iov_iter 实现。 |

## 阅读记录与验证注意事项

- [Discussion #291：KMiri 与 UML 内核模块 RPC 直通][discussion-291]：早期设计讨论，包含黑盒 `passthrough` 的适用性和漏报风险；具体实现以 Linux [#3][linux-3] 和 Miri [#67][miri-67] 为准。
- [Discussion #293：C2Rust `bindings` + UML 规划][discussion-293]：总体路线建议，不等同已提交实现。
- [Discussion #295：从 Linux C 源码转译 bitmap 的实验][discussion-295]：详细记录路径 C 的输入、补丁、运行方式和 Stacked Borrows 结果；它是实验记录，不是 Linux [#4][linux-4] 的实现说明。
- [Discussion #296：RFL、UML 与分配器][discussion-296]：解释 UML 下 `KBox`/`Kmalloc` 与 libc 分配的区别。
- [Discussion #314：DRM `drm::device::Device::new` 失败路径复现][discussion-314]：局部 C stand-in 和失败/修复/成功对照实验。

所有测试结论都应注明实际测试路径与配置。特别是关闭 Stacked Borrows 的通过结果只说明该配置下测试运行完成；RPC 只能验证输入输出往返；转译后代码仍须审查人工修改和未覆盖的原子、分配及并发语义。


[linux-1]: https://github.com/KMiri-rs/linux/pull/1
[linux-2]: https://github.com/KMiri-rs/linux/pull/2
[linux-3]: https://github.com/KMiri-rs/linux/pull/3
[linux-4]: https://github.com/KMiri-rs/linux/pull/4
[linux-5]: https://github.com/KMiri-rs/linux/pull/5
[linux-6]: https://github.com/KMiri-rs/linux/pull/6
[linux-7]: https://github.com/KMiri-rs/linux/pull/7

[miri-64]: https://github.com/KMiri-rs/miri/pull/64
[miri-67]: https://github.com/KMiri-rs/miri/pull/67
[miri-68]: https://github.com/KMiri-rs/miri/pull/68
[miri-71]: https://github.com/KMiri-rs/miri/pull/71
[miri-73]: https://github.com/KMiri-rs/miri/pull/73

[discussion-291]: https://github.com/orgs/KMiri-rs/discussions/291
[discussion-293]: https://github.com/orgs/KMiri-rs/discussions/293
[discussion-295]: https://github.com/orgs/KMiri-rs/discussions/295
[discussion-296]: https://github.com/orgs/KMiri-rs/discussions/296
[discussion-314]: https://github.com/orgs/KMiri-rs/discussions/314
