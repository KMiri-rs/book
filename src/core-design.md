# 核心设计

## Pseudo Physical Memory

### 地址空间布局

[描述预留区布局、对齐要求、容量限制。]

### 页粒度管理

[描述页大小、页状态初始值、状态转换入口。]

### 与内核分配语义对接

[描述 runtime 分配与 OS 管理页如何统一映射。]

## Page State Tracking

### 页状态模型

[建议列出状态：Free / Reserved / Untyped / Typed / ...]

### 状态转换规则

[填写允许转换、禁止转换、错误条件。]

### 访问校验策略

[说明 typed/untyped 访问约束、错误上报信息。]

## Page Table Model

### 当前根页表管理

[说明 set/get root 的语义与时序要求。]

### 访存时页表遍历

[说明 walk 流程与失败场景。]

### 映射一致性检查

[说明 stale mapping、非法别名映射等检测逻辑。]

## Address-Aware Allocation

### 分配绑定地址策略

[说明 Allocation 如何绑定到伪物理地址。]

### Runtime Allocation 迁移

[说明栈/static 等对象在首次访问时迁移的机制。]

### 栈回收与空间控制

[说明 unwind 时回收策略与地址耗尽防护。]

## Kernel Thread Model

### 线程创建与切换

[描述 create/switch 调用后的解释器状态变化。]

### 栈模型

[说明线程独立栈区与边界检查。]

## SMP 与 CPU-Local

### 多 CPU 抽象

[说明 CPU 上下文、线程绑定与切换。]

### CPU-local 数据管理

[说明 CPU-local 区域布局及访问约束。]

### 竞态路径探索

[说明随机切换策略和可复现性（seed）策略。]

## Shims API 设计

### API 分组

* 页管理 API：[alloc/dealloc/type]
* Untyped 读写 API：[read/write/copy]
* 页表 API：[set/get root page table]
* 线程/CPU API：[create/switch/ap init]

### 调用契约与不变量

[例如：禁止重复分配同一页、禁止对未分配页 retype。]

### 错误模型

[填写 API 误用时的错误分类与报告格式。]
