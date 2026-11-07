# 附录

## Shims API 完整清单

[把当前所有 API 原型和语义约束放在这里，便于查阅。]

## 配置项与默认值

[地址、容量、对齐、开关项、实验性参数。]

## 模拟器

本节不是“最全名单”，而是按集成方式组织：既覆盖 QEMU 生态这类平台级分析路线，也覆盖更易库化嵌入的执行引擎，方便按场景选型。

r[emulator.qemu]

这张表聚焦 QEMU 及其衍生分析生态，强调“进程级仿真底座 + 外部控制/插件扩展”的技术路径。

| 项目    | Star  | 技术路线                                                                   | 典型场景                                        |
|---------|-------|----------------------------------------------------------------------------|-------------------------------------------------|
| [QEMU]  | 13.9k | 通用系统/用户态仿真 + TCG 动态翻译；以进程级控制（QMP/gdbstub/plugin）为主 | 全系统调试、跨架构复现、动态插桩与观测          |
| [PANDA] | 2.8k  | 基于 QEMU 的平台级动态分析框架（Record/Replay + 插件体系）                 | 恶意样本行为分析、全系统溯源、污点/数据流分析   |
| [S2E]   | 526   | QEMU + KLEE 的选择性符号执行（Selective Symbolic Execution）               | 系统级路径探索、漏洞触发条件挖掘、驱动/固件分析 |
| [AFL++] | 6.8k  | 利用 `qemu_mode` 做二进制灰盒 fuzzing（无需源码重编译）                    | 闭源程序 fuzzing、跨架构目标覆盖引导测试        |

[QEMU]: https://github.com/qemu/qemu
[PANDA]: https://github.com/panda-re/panda
[S2E]: https://github.com/S2E/s2e
[AFL++]: https://github.com/AFLplusplus/AFLplusplus

r[emulator.riscv]

这张表聚焦 RISC-V 上可直接嵌入宿主程序的执行引擎/分析框架，便于做库级集成。

| 模拟器         | 接口/语言        | 模式                   | Star | 亮点                                                | 典型场景                              |
|----------------|------------------|------------------------|------|-----------------------------------------------------|---------------------------------------|
| [RVVM]         | C API            | 全系统                 | 3.5k | 轻量、JIT，能启动发行版                             | 程序内跑完整 RISC-V 系统              |
| [Spike]        | C++ 库           | 用户态 + 全系统        | 3k   | RISC-V 官方参考实现                                 | 工具链、架构测试、验证                |
| [TinyEMU]      | C （可裁剪嵌入） | 全系统                 | 1.7k | Fabrice Bellard 出品，极小                          | 轻量全系统仿真                        |
| [Unicorn]      | C + Rust 绑定    | 用户态                 | 8.5k | 指令/内存 hook，支持 RV32/RV64                      | CTF、逆向、恶意样本分析               |
| [angr]         | Python 框架      | 用户态 （符号执行）    | 5.5k | 符号执行、路径探索                                  | 漏洞分析、自动化逆向                  |
| [Qiling]       | Python 框架      | 用户态 （+syscall 层） | 2.7k | 补齐 syscall 的用户态 OS 仿真                       | 样本仿真、沙箱分析                    |
| [mini-rv32ima] | 单文件 C         | 用户态                 | 2.3k | 零依赖、极简 RV32IMA                                | 嵌入式小项目、教学、WASM 移植         |
| [libriscv]     | C++17 库         | 用户态                 | 1.8k | 直接加载 ELF、自定义 syscall、多线程/coroutine、JIT | 游戏 mod 沙箱、插件系统（s&box 在用） |
| [sail-riscv]   | OCaml 库         | 用户态                 | 1.6k | 形式化 golden model                                 | 证明/验证工程                         |

[RVVM]: https://github.com/LekKit/RVVM
[Spike]: https://github.com/riscv-software-src/riscv-isa-sim
[TinyEMU]: https://bellard.org/tinyemu/
[Unicorn]: https://www.unicorn-engine.org/
[angr]: https://angr.io/
[Qiling]: https://qiling.io/
[mini-rv32ima]: https://github.com/cnlohr/mini-rv32ima
[libriscv]: https://github.com/fwsGCC/libriscv
[sail-riscv]: https://github.com/riscv/sail-riscv

r[emulator.x86_64]

这张表聚焦 x86-64 的库化执行与分析技术，侧重可编排、可插桩、可与业务逻辑联动。

| 模拟器/技术 | 接口/语言     | 模式                   | Star | 亮点                                               | 典型场景                                 |
|-------------|---------------|------------------------|------|----------------------------------------------------|------------------------------------------|
| [Unicorn]   | C + Rust 绑定 | 用户态                 | 8.5k | 细粒度 hook、上下文可控，适合嵌入                  | 指令级沙箱、逆向分析、程序内执行客体代码 |
| [QBDI]      | C++/C API     | 用户态（DBI/虚拟执行） | 4.2k | 可插桩执行基本块/指令，易与宿主逻辑集成            | 运行时监控、污点传播、内嵌分析器         |
| [Qiling]    | Python 框架   | 用户态（+syscall 层）  | 2.7k | 为 x86/x86-64 补 syscall/OS 抽象，脚本化扩展成本低 | 恶意样本仿真、快速搭建用户态沙箱         |
| [angr]      | Python 框架   | 用户态（符号执行）     | 5.5k | VEX IR + 路径探索，可与具体执行结合                | 二进制漏洞挖掘、自动化逆向               |
| [Miasm]     | Python 框架   | 用户态（解释执行/JIT） | 2.6k | 反汇编 + IR + 执行一体化，适合做嵌入式分析流水线   | 程序内做反汇编/仿真联动、补丁验证        |

[QBDI]: https://github.com/QBDI/QBDI
[Miasm]: https://github.com/cea-sec/miasm

r[emulator.arm]

这张表聚焦 ARM/AArch64 方向的嵌入式引擎与分析框架，覆盖固件、Android Native 与通用二进制分析场景。

| 模拟器/技术 | 接口/语言     | 模式                     | Star | 亮点                                                     | 典型场景                                 |
|-------------|---------------|--------------------------|------|----------------------------------------------------------|------------------------------------------|
| [Unicorn]   | C + Rust 绑定 | 用户态                   | 8.5k | 支持 ARM/Thumb/AArch64，hook 机制成熟                    | 固件片段执行、逆向、嵌入式安全分析       |
| [Dynarmic]  | C++ 库        | 用户态                   | 2.5k | 高性能 ARM32/AArch64 动态重编译器，专注做“可嵌入 CPU 核” | 模拟器内核、游戏机/移动端 CPU 子系统仿真 |
| [Qiling]    | Python 框架   | 用户态（+syscall 层）    | 2.7k | 对 ARM Linux/Android 样本友好，脚本化接入快              | IoT/Android 样本仿真、自动化分析流水线   |
| [angr]      | Python 框架   | 用户态（符号执行）       | 5.5k | ARM/AArch64 符号执行成熟，便于和 fuzz/静态分析联动       | 固件审计、路径可达性分析                 |
| [unidbg]    | Java 框架     | 用户态（Android Native） | 5.3k | 把 ARM/ARM64 native library 当库加载并驱动 JNI 调用      | App native 层逆向、协议/加密逻辑复现     |

[Dynarmic]: https://github.com/lioncash/dynarmic
[unidbg]: https://github.com/zhkl0228/unidbg


## 参考资料

* [README.md]
* [KernMiri-Overview.md]
* [相关论文/博客/issue/pr 链接]
