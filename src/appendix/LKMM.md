# LKMM

## 一句话总结

> LKMM 不是“自动验证整棵源码”的工具，而是“并发语义规范 + litmus 实验方法”，用于把并发审查从经验判断变成可判定论证。

## 1. LKMM 是什么

`LKMM`（Linux Kernel Memory Model）是 Linux 内核并发内存语义的形式化规范。

- 它回答：某个并发执行结果在 Linux 语义下是否允许。
- 它不回答：某个仓库是否已经被自动证明“全局无并发 bug”。

工程上可把它看成三件套：

- **LKMM**：规则（内存序语义）；
- **litmus tests**：最小化并发问题描述；
- **herd7**：在模型下穷举执行并判定结果是否可达。

## 2. 为什么要在代码审查里使用 LKMM

并发 review 中最常见分歧是：

- “在 x86 上没复现问题，所以应该没问题”；
- “这段代码看起来有顺序，但我说不清哪里会坏”。

LKMM 的价值是把这种分歧转成可检验命题：

- 先把真实代码抽象成最小并发模式；
- 明确“我担心的坏结果”；
- 用模型判定该结果是否允许；
- 再决定该加什么同步原语。

## 3. 一个完整审查示例（从补丁到结论）

下面给出一个与实际 review 非常接近的流程。

### 3.1 发现可疑补丁（无锁发布-订阅）

补丁中看到类似代码：

```c
/* producer CPU */
WRITE_ONCE(obj->data, payload);
WRITE_ONCE(obj->ready, 1);

/* consumer CPU */
if (READ_ONCE(obj->ready) == 1)
    consume(READ_ONCE(obj->data));
```

作者主张：`ready=1` 后读 `data` 就应是新值。

审查者的疑问：是否可能出现“看到 `ready=1` 但看到旧 `data`”？

### 3.2 抽象为 litmus（保留并发本质）

```litmus
C MP-flag-data-buggy

{}

P0(int *data, int *ready)
{
    WRITE_ONCE(*data, 1);
    WRITE_ONCE(*ready, 1);
}

P1(int *data, int *ready)
{
    int r0;
    int r1;

    r0 = READ_ONCE(*ready);
    if (r0 == 1)
        r1 = READ_ONCE(*data);
}

exists (1:r0=1 /\ 1:r1=0)
```

这里的 `exists` 就是“坏结果定义”：

- 消费者确实看到了 `ready=1`；
- 但仍读到旧 `data=0`。

### 3.3 用 herd7 判定

典型运行方式：

```bash
herd7 -conf linux-kernel.cfg MP-flag-data-buggy.litmus
```

若该 `exists` 被判定 `Allowed`（或等价地非 `Never`），则说明当前同步不足。

### 3.4 推导修复策略

这里的关键不是“多加一个 once”，而是建立发布-订阅同步边：

```c
/* producer CPU */
WRITE_ONCE(obj->data, payload);
smp_store_release(&obj->ready, 1);

/* consumer CPU */
if (smp_load_acquire(&obj->ready) == 1)
    consume(READ_ONCE(obj->data));
```

再写一份 fixed litmus：

```litmus
C MP-flag-data-fixed

{}

P0(int *data, int *ready)
{
    WRITE_ONCE(*data, 1);
    smp_store_release(ready, 1);
}

P1(int *data, int *ready)
{
    int r0;
    int r1;

    r0 = smp_load_acquire(ready);
    if (r0 == 1)
        r1 = READ_ONCE(*data);
}

exists (1:r0=1 /\ 1:r1=0)
```

预期是：该坏结果不再可达（`Forbidden/Never`）。

### 3.5 把结论回填到审查意见

高质量 review comment 通常包含三点：

1. **问题定义**：当前写法允许 `ready=1 && data=old`；
2. **模型依据**：在 LKMM litmus 中该结果可达；
3. **修复建议**：改为 `smp_store_release/smp_load_acquire` 配对，并注明配对关系。

可直接写成：

```c
/* Pairs with smp_load_acquire() on consumer side. */
smp_store_release(&obj->ready, 1);
```

这能显著降低后续“看不懂为什么这样写”的回归风险。

## 4. 为什么这个示例里 `READ_ONCE/WRITE_ONCE` 不够

`READ_ONCE/WRITE_ONCE` 主要解决：

- 单次访问不被编译器拆分/合并；
- 限制一部分编译器层重排。

但它们不自动建立发布-订阅所需的跨 CPU 同步边。
因此“flag + data”模式通常需要 release/acquire 或锁，而不是仅靠 once 宏。

## 5. LKMM 在实践中的边界

LKMM 能做：

- 给并发模式提供形式化可判定依据；
- 指导屏障/原子/锁原语选择；
- 让审查结论可复现、可讨论。

LKMM 不能做：

- 直接验证整棵工程代码“绝对正确”。

因此成熟流程通常是互补组合：

- **LKMM/litmus/herd7**：模式级论证；
- **lockdep**：锁顺序与上下文规则检查；
- **KCSAN**：动态数据竞争检测。

## 6. 审查者速用清单

看到并发补丁可先问 5 个问题：

1. 共享变量有哪些？谁写谁读？
2. 是否存在“状态位发布数据”模式？
3. 当前同步语义是锁、release/acquire 还是仅 once？
4. 坏结果能否写成一个 `exists (...)`？
5. 修复后是否有成对语义注释（pairing comment）？

只要这 5 问能答清，review 质量会明显提升。

## 7. 术语表

- **LKMM**：Linux Kernel Memory Model，Linux 并发内存语义的形式化规范。
- **litmus test**：最小并发实验程序，用于询问某个结果是否允许。
- **herd7**：在给定内存模型下穷举 litmus 执行并判定可达性的工具。
- **Allowed / Forbidden**：某个观察结果在模型下可达 / 不可达。
- **exists 子句**：litmus 里定义“关注结果”的逻辑条件。
- **release / acquire**：发布-获取语义；典型配对是 `smp_store_release` 与 `smp_load_acquire`。
- **READ_ONCE / WRITE_ONCE**：保证单次访问语义并抑制部分编译器优化，但不等同完整跨 CPU 同步。
- **happens-before（hb）**：跨执行流的先行关系；并发正确性的关键语义边。
- **发布-订阅（publish-subscribe）**：先写数据再发布状态位，订阅者看到状态后读取数据。
- **模式级验证**：验证抽象并发模式，而非整仓自动证明。

