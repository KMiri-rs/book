# 10. 附录

## 10.1 Shims API 完整清单

[把当前所有 API 原型和语义约束放在这里，便于查阅。]

## 10.2 配置项与默认值

[地址、容量、对齐、开关项、实验性参数。]

## 10.3 模拟器

r[emulator.riscv]

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


## 10.4 参考资料

* [README.md]
* [KernMiri-Overview.md]
* [相关论文/博客/issue/pr 链接]
