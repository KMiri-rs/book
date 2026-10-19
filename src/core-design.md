# 核心设计

本章对应[适配路线图的固定版本](overview.md#r-overview.adaptation)，以 [KernMiri-Overview](https://github.com/KMiri-rs/KMiri/blob/33963c7ebde744f52657d4205b39e42a9bbefd23/KernMiri-Overview.md#L1-L30) 为设计线索，并按解释器及内核源码核对接口与行为。以下“已接入”表示存在调用；运行成果另见[适配路线图](overview.md#r-overview.adaptation)。

## Pseudo Physical Memory

### 地址空间布局

r[core.memory.layout]

解释器分配一块按页对齐的宿主缓冲区，以其中的偏移表示内核物理地址。默认容量为 128 MiB；前 16 MiB 留给启动页表、static、CPU-local 和解释器栈，其余区域用于内核管理的页。默认内核映射基址为 `0xffffffff80000000`，启动线性映射基址为 `0xffff800000000000`。

* **布局与配置**：[默认配置](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/config.rs#L97-L117)、[TOML 字段](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/config_toml.rs#L8-L36) → [Tock 配置](https://github.com/KMiri-rs/tock/blob/b07f8a811d7fc6317f6a77ea0b066d8ecf80134c/boards/qemu_rv64_virt/kmiri.toml#L1-L20)。TOML 可指定容量、栈大小、布局符号与 `kalloc` 区间；Tock 已使用 `page_table = false`，其地址按恒等关系处理，不套用默认高半区映射。

### 页粒度管理

r[core.memory.pages]

页大小固定为 4 KiB。启用分页时，初始化页状态表：解释器保留区为 `Typed(Interpreter)`，其余为 `Unused`；内核通过页接口通知分配和用途变化。关闭分页时不建立这张页状态表，配置区间不因此获得相同的页生命周期检查。

* **缓冲区与页状态初始化**：[PhysicalMemory::new](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L414-L435)、[页大小与页数](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/config.rs#L169-L182) → [星绽单页分配](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/frame/allocator.rs#L53-L76)。该分配路径已报告页事件；连续段分配／释放通知的缺口见 [asterinas#27](https://github.com/KMiri-rs/asterinas/pull/27)。

### 与内核分配语义对接

r[core.memory.allocations]

伪物理内存提供字节存储，Miri 的 `Allocation` 提供对象范围、初始化位和指针检查记录。内核管理的 typed 页按 slot 建立对象；解释器生成的栈与 static 使用预留区。两者最终指向同一物理缓冲区中的字节，而不是维护两份彼此独立的内存。

* **指定地址的对象**：[create_allocation_at](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L52-L84) → [slab 页重类型化](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/heap/slab.rs#L104-L119)。单页对象会继承页的初始化位；跨页初始化位继承仍有源码 FIXME，不将其描述为全部完成。

## Page State Tracking

### 页状态模型

r[core.page-state.model]

实际状态为 `Unused`、`Untyped`、`Typed { page_type, slot_size }`。`TypedKind` 包含 `Slab`、`PageTable`、`Stack`、`Interpreter`；`slot_size` 决定该页拆成多大的 Miri 对象。`Free`、`Reserved` 不是当前枚举中的状态。

* **状态及用途枚举**：[PageState / TypedKind](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L461-L498) → [页表页调用](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/page_table/node/mod.rs#L72-L87)、[slab 调用](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/heap/slab.rs#L104-L119)。这两类用途已有调用，其他枚举成员不据此推定已有内核用例。

### 状态转换规则

r[core.page-state.transitions]

页分配要求 `Unused → Untyped`；重类型化要求 `Untyped → Typed`，且 slot 大小整除页大小；释放将已分配页变回 `Unused`，移除该页的初始化位和 typed slot 对象。重复分配、释放 `Unused` 页或从错误状态重类型化会被拒绝。

* **分配／重类型化**：[分配与释放入口](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L906-L925)、[重类型化入口](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L956-L969) → [重复分配负例](https://github.com/KMiri-rs/KMiri/blob/33963c7ebde744f52657d4205b39e42a9bbefd23/tests/ub-page-state/src/lib.rs#L7-L20)；基线已有测试代码。
* **释放清理**：[dealloc_pages](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L135-L173) → [启动页表释放通知](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/page_table/boot_pt.rs#L80-L99)。普通 frame 的释放通知尚未完整接入；[asterinas#27](https://github.com/KMiri-rs/asterinas/pull/27) 为待合并修复，不计入基线。

### 访问校验策略

r[core.page-state.access]

typed 页的访问按 slot 找到或创建 Miri 对象，再进入对象访问检查；untyped 复制走专用接口，按页翻译地址、验证两端为 `Untyped`，并复制初始化位。复制不会把未初始化字节变成已初始化字节，也不为 typed 对象重建借用权限。

* **状态校验**：[check_page_state](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L337-L353) → 上述页接口及负例。状态不符时报告物理地址、页索引和期望／实际状态。
* **Untyped 复制**：[physical_copy](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L197-L295) → [未初始化复制负例](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/tests/fail/kmiri/physical-copy-uninitialized.rs#L1-L33)、[已初始化复制正例](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/tests/pass/kmiri/physical-copy-initialized.rs#L1-L34)。这些是解释器回归用例，不等于星绽所有复制路径已接入。

## Page Table Model

### 当前根页表管理

r[core.page-table.root]

分页模式维护当前根页表物理地址。启动时在 `0x1000 / 0x2000 / 0x3000` 建立初始表，提供内核与线性映射；内核切换根页表时，shim 替换解释器保存的根地址。当前根是全局状态，不是每 CPU 独立的根页表。

* **启动与切根**：[启动页表](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/page_table.rs#L7-L66)、[set/get root](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L970-L978) → [星绽激活／查询根页表](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/mm/mod.rs#L113-L139)；已接入内核架构层。

### 访存时页表遍历

r[core.page-table.walk]

地址解析使用当前根页表逐级读取 PTE，得到物理地址后查找 Miri 对象。当前实现是**四级页表、8 字节 PTE**，识别 present 和 huge-page 位。它不是适用于所有架构的通用 MMU 模型，也未完整检查硬件读写权限。

* **地址转换**：[page_walk](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/page_table.rs#L102-L162) → [地址到对象的解析入口](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/alloc_addresses/mod.rs#L425-L454)。该入口仍有内核／启动线性映射 fallback，不能将所有 walk 失败都表述为已经报告映射错误。
* **无分页模式**：[kalloc 查询](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/alloc_addresses/mod.rs#L491-L505) → [Tock 地址声明](https://github.com/KMiri-rs/tock/blob/b07f8a811d7fc6317f6a77ea0b066d8ecf80134c/boards/qemu_rv64_virt/kmiri.toml#L1-L20)；按配置建立地址对应对象，不执行页表 walk。

### 映射一致性检查

r[core.page-table.consistency]

页表页写入已有观察入口，但“写入后检查是否暴露 typed 对象、是否产生失效映射”等一致性检查尚未完成。这里需与已经工作的地址翻译分开。

* **已有写入观察**：[PageTable 写入标记](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/machine.rs#L1844-L1853) → [下一步执行前消费标记](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/scheduler.rs#L206-L219)。消费处仍保留 TODO；当前没有完整实现或对应验收依据。
* **TLB 边界**：[星绽 flush 接口](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/mm/mod.rs#L78-L95)当前为空操作，未模拟 TLB 缓存及失效。stale mapping 检测留待[后续页表适配](overview.md#r-overview.adaptation)验收。

## Address-Aware Allocation

### 分配绑定地址策略

r[core.allocation.binding]

解释器记录 `AllocId` 与物理基址的对应关系。访问尚无对象记录的 typed slot 时，按 slot 大小与对齐创建内核对象，并注册该对象的根指针权限；不同虚拟地址若解析到同一物理对象，应落到同一地址记录。

* **延迟对象创建**：[typed slot 与 kernel_allocation_at](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/alloc_addresses/mod.rs#L365-L420) → [slab 用途声明](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/heap/slab.rs#L104-L119)。已有调用链；slot 模型仍需覆盖真实分配器的细粒度释放与复用，不能仅以页仍存在判断对象仍存活。

### Runtime Allocation 迁移

r[core.allocation.migration]

栈对象取得具体地址后，将后端字节放到线程栈对应的伪物理区域；static 对象也放入预留区。迁移同时处理初始化位和指针 provenance，避免仅复制字节就把未知数据视为已初始化。

* **栈迁移**：[adjust_alloc_root_pointer](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/alloc_addresses/mod.rs#L678-L751) → [无分页地址转换测试](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/tests/pass/kmiri/no-paging-pointer-cast.rs#L1-L26)；已有解释器测试。
* **Static 迁移**：[static 字节与 provenance 迁移](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/machine.rs#L1719-L1767) → 内核 Rust static 的解释执行路径。这里说明迁移机制，不据此宣称所有内核对象的检查历史都已完整保留。

### 栈回收与空间控制

r[core.allocation.reclaim]

每个线程保存栈地址游标与调用帧记录。函数调用记录当前位置，返回／展开时恢复游标，避免每次调用都永久消耗伪物理地址；对象释放还需移除地址查询与暴露记录。

* **游标与回收**：[调用时记录](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/machine.rs#L2080-L2096)、[返回／展开时恢复](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/machine.rs#L2138-L2185)、[free_alloc_id](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/alloc_addresses/mod.rs#L866-L905) → [任务及函数调用用例](https://github.com/KMiri-rs/KMiri/blob/33963c7ebde744f52657d4205b39e42a9bbefd23/tests/init/src/lib.rs#L7-L19)。机制已有实现；该用例不是地址耗尽或长期复用的专项验证。

## Kernel Thread Model

### 线程创建与切换

r[core.thread.switch]

`miri_create_new_thread` 为内核任务创建 Miri 线程，记录任务指针与线程 ID；`miri_switch_to` 按任务指针请求切换，解释器在调度入口应用该请求。内核仍执行自己的调度选择，而不是由 shim 重新实现调度器。

* **创建／切换实现**：[线程 shims](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L874-L904)、[应用切换请求](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/thread.rs#L795-L842) → [星绽创建任务](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/task/scheduler/mod.rs#L538-L556)、[星绽切换任务](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/task/processor.rs#L95-L101)；[init](https://github.com/KMiri-rs/KMiri/blob/33963c7ebde744f52657d4205b39e42a9bbefd23/tests/init/src/lib.rs#L7-L19)已有创建及 yield 调用。
* **当前缺口**：任务入口的调度收尾与退出仍有待修复路径，见 [asterinas#28](https://github.com/KMiri-rs/asterinas/pull/28)、[KMiri#277](https://github.com/KMiri-rs/KMiri/issues/277)，不将该基线描述为完整任务生命周期支持。

### 栈模型

r[core.thread.stack]

线程使用独立的栈地址范围。内核可通过 `stack_end` 与 `stack_size` 显式传入范围，未传入时解释器按配置分配。栈局部对象仍由 MIR 执行创建，不模拟汇编栈帧布局。

* **栈范围**：[Stack 类型](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/thread.rs#L846-L849)、[默认栈分配](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/thread.rs#L916-L939) → [传入任务栈范围](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/task/scheduler/mod.rs#L541-L556)；星绽已使用显式范围，其他内核当前的启动入口不据此视为已接入线程切换。

## SMP 与 CPU-Local

### 多 CPU 抽象

r[core.smp.cpus]

当前解释器预设两个 CPU 槽位，记录活跃 CPU、各 CPU 绑定的线程和待切换线程。`kern_miri_init_ap` 创建指定 CPU 的初始线程，并绑定入口、参数及栈。

* **CPU／线程关系**：[CPU_NUM](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/machine.rs#L494-L494)、[CPU 状态](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/thread.rs#L468-L490)、[AP 初始化](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L851-L873) → 星绽只有[接口声明](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/mod.rs#L102-L109)，其[AP 启动](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/boot/smp.rs#L6-L12)尚为空。基线尚无多 CPU 启动与切换的运行验证。

### CPU-local 数据管理

r[core.smp.cpu-local]

解释器保存每 CPU 的 CPU-local 基址，get/set 接口操作当前 CPU 的记录。带 `.cpu_local` 标记的 static 进入预留区；但 `kern_miri_get_cpu_local_va` 当前直接返回传入地址，不能据此认为跨 CPU 地址重定位已经完成。

* **基址与地址查询**：[get/set base](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L834-L850)、[地址查询及未启用的重定位代码](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L979-L1009)、[CPU-local static 识别](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/machine.rs#L1565-L1572) → [星绽 CPU-local 基址访问](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/cpu/local.rs#L5-L16)；基址访问已接入，多 CPU 独立数据仍待验收。

### 竞态路径探索

r[core.smp.scheduling]

解释器可在执行步之间请求切换 CPU：以 2% 概率尝试下一个 CPU，仅在其已有绑定线程时生效。线程切换请求与 CPU 切换由同一调度入口处理。复现随机路径需同时固定版本、配置和 Miri seed。

* **切换策略**：[线程抢占与 CPU 切换](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/thread.rs#L1362-L1379) → [调度入口](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/concurrency/scheduler.rs#L80-L91)。策略已有实现；星绽单 CPU、TockOS 无中断循环和 BlueOS 单核启动均不是多核竞争路径的运行证据。

## Shims API 设计

### API 分组

r[core.shims.groups]

以下列出固定版本中实际由解释器处理的接口；内核 extern 声明并不保证解释器已有同名实现。

* **页管理**：`kern_miri_alloc_pages`、`kern_miri_dealloc_pages`、`kern_miri_retype_pages` → [解释器分派](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L906-L969) → 星绽分配器、slab 与页表页调用；释放通知尚有缺口，见[状态转换](#r-core.page-state.transitions)。
* **原始字节操作**：`kern_miri_zero`、`kern_miri_write_bytes`、`kern_miri_copy_untyped` → [清零／写入](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L926-L955)、[untyped 复制](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L1010-L1017) → 星绽已有[清零调用](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/frame/allocator.rs#L68-L76)；后两个接口未见星绽调用，`copy_untyped` 有[上述回归用例](#r-core.page-state.access)。星绽[声明](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/mod.rs#L86-L100)的 `kern_miri_read_u8_untyped`、`kern_miri_write_u8_untyped` 与 `kern_miri_copy` 在解释器分派中没有同名实现；其中 `kern_miri_copy` 已有[内核调用](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/mm/io/copy.rs#L163-L176)，尚待接入。
* **页表**：`kern_miri_set_root_page_table`、`kern_miri_get_root_page_table` → [解释器分派](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L970-L978) → [星绽根页表访问](https://github.com/KMiri-rs/asterinas/blob/e255c1ed5550dc2965c535c824f17f9f353fc31e/ostd/src/arch/miri/mm/mod.rs#L113-L139)，已接入。
* **线程／CPU**：`miri_create_new_thread`、`miri_switch_to`、`kern_miri_init_ap`、`kern_miri_get_cpu_local_base`、`kern_miri_set_cpu_local_base`、`kern_miri_get_cpu_local_va` → [线程／CPU 分派](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L834-L904)及[CPU-local 地址](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L979-L1009) → 星绽任务与基址调用已接入，AP 启动和地址重定位未完成。

TockOS 与 BlueOS 当前主要使用配置声明与架构薄适配，不要求它们采用整套星绽页事件接口。BlueOS 的 [启动器](https://github.com/KMiri-rs/vivoblueos-build/blob/7051c5eebc574c9ff3013c962af253ebf55e174c/scripts/miri/boot.py#L17-L66)复用 GN 编译参数，[架构适配](https://github.com/KMiri-rs/vivoblueos-kernel/blob/8ff38027d595c29323c759aa6ae244437bf48292/arch/src/miri.rs#L1-L31)提供有限架构状态；这与上述页生命周期接口是不同的接入位置。

### 调用契约与不变量

r[core.shims.contracts]

页接口以物理地址和页数为单位，重类型化还需提供合法用途与 slot 大小；线程切换必须引用已登记的任务。内核需要在相应生命周期事件发生时调用接口，否则解释器的记录不会自动跟随内核变化。

* **已检查的约束**：[分配前状态](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L906-L918)、[重类型化前状态与 slot](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L956-L969)、[任务存在性](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L895-L904) → 重复分配负例及星绽调用链。
* **待统一的约束**：页对齐、范围、用途值、清零／写入状态尚未全部转成一致的参数检查；当前仍有 `assert`／`unwrap`。接口契约是接入要求，不等于每个入口已完整验证契约。

### 错误模型

r[core.shims.errors]

当前有三类结果：页状态或 untyped 复制违规报告 UB；切换到未登记任务会中止执行；部分非法参数或缺失内部记录仍会触发解释器 panic。应区分内核缺陷、适配遗漏与解释器自身错误，而不是把所有失败都记为内核 UB。

* **已有诊断**：[页状态 UB](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/mirch/physical_mem.rs#L337-L353)、[错误切换 abort](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L895-L904)、[清零中的 unwrap](https://github.com/KMiri-rs/miri/blob/af87bdb338e347872bc2429308e2865901488bfb/src/shims/foreign_items.rs#L926-L943) → [KMiri#261](https://github.com/KMiri-rs/KMiri/issues/261) 是缺失初始化位记录导致 panic 的实例，相关修复不在本基线。定位方式见[检查能力与错误模型](checking-and-error-model.md)。
