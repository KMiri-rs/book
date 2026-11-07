# 中断与 spinlock 死锁小结

## 一句话结论

> 只要一把 spinlock 可能在中断上下文里被获取，那么普通上下文获取它时就必须屏蔽本地中断（如 `irqsave/irqrestore`），否则可能出现“自己等自己”的死锁。

## 1. 典型死锁路径

1. 线程/进程上下文拿到 `lock`，但没有关本地中断；
2. 当前 CPU 被硬中断打断，进入中断处理函数；
3. 中断处理函数也尝试拿同一把 `lock`；
4. handler 自旋等待，而释放锁的执行流被 handler 打断，无法继续执行；
5. 系统卡死在这条路径上。

这是“同一 CPU 上的重入死锁”，本质是异步上下文重入同一锁。

## 2. 什么时候要用哪种锁接口

- 仅线程上下文使用、不会被中断 handler 触达：`spin_lock/spin_unlock`。
- 线程上下文与硬中断共享同一把锁：`spin_lock_irqsave/spin_unlock_irqrestore`。
- 线程上下文与 softirq/bottom-half 共享：通常用 `spin_lock_bh/spin_unlock_bh`。

判断原则：先问“这把锁会不会在异步上下文里被拿到”，再选接口。

## 3. 用户态能否复现

可以复现“同类机制”，但不是硬中断本体。

在用户态可用 `signal handler` 模拟异步打断：主线程先获取自旋锁，再向自己发送 `SIGUSR1`，handler 里再次获取同一锁，即可卡住。这和内核里的“持锁时被中断重入同锁”在并发结构上等价。

优点：

- 代码小、复现快；
- 便于教学和理解死锁成因。

局限：

- 信号不等于硬中断；
- 无法覆盖内核抢占模型、IRQ 屏蔽语义与真实中断子系统细节。

### 3.1 `deadlock.c` 最小复现代码

```c
// deadlock_signal_spin.c
#define _GNU_SOURCE
#include <stdatomic.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
#include <pthread.h>

static atomic_flag lock = ATOMIC_FLAG_INIT;
static pthread_t main_tid;

static inline void spin_lock(atomic_flag *l) {
    while (atomic_flag_test_and_set_explicit(l, memory_order_acquire)) { }
}
static inline void spin_unlock(atomic_flag *l) {
    atomic_flag_clear_explicit(l, memory_order_release);
}

void handler(int signo) {
    (void)signo;
    write(1, "[handler] try lock\n", 19);
    spin_lock(&lock); // 如果主线已持锁，这里会一直自旋
    write(1, "[handler] got lock (unexpected)\n", 32);
    spin_unlock(&lock);
}

int main(void) {
    main_tid = pthread_self();

    struct sigaction sa = {0};
    sa.sa_handler = handler;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);

    write(1, "[main] lock\n", 12);
    spin_lock(&lock);

    write(1, "[main] send signal to self\n", 27);
    pthread_kill(main_tid, SIGUSR1); // 异步打断到同一线程

    // 理论上到不了这里（handler 在自旋）
    write(1, "[main] unlock\n", 14);
    spin_unlock(&lock);
    return 0;
}
```

运行方式：

```bash
gcc -O2 -pthread deadlock.c -o deadlock_demo
./deadlock_demo
```

预期现象：程序打印到 `"[handler] try lock"` 后卡住，说明发生了“异步重入同锁”的自旋死锁。

## 4. 是否必须内核态

如果目标是“理解机制”，用户态信号实验足够。

如果目标是“验证真实内核语义”，需要内核态（通常在 QEMU 中）：

- 让进程上下文路径与中断 handler 共享同一自旋锁；
- 先用错误写法（不关中断）触发死锁；
- 再改成 `irqsave/irqrestore` 观察问题消失。

## 5. 相关术语速记

- `SIGUSR1`：用户自定义信号 1，用于异步通知。
- `struct sigaction sa = {0};`：把结构体做零初始化，再注册 handler。
- `atomic_flag_test_and_set_explicit`：原子“测试并置位”，返回旧值；自旋锁常用它实现。
- Rust 对应写法：常用 `AtomicBool::swap(true, Ordering::Acquire)` 获取锁，`store(false, Ordering::Release)` 释放锁。

## 6. 审查清单

1. 该共享状态是否会被中断路径访问？
2. 同一把锁是否跨线程上下文与中断上下文复用？
3. 普通路径拿锁时是否使用 `irqsave/irqrestore`（或等价封装）？
4. 临界区是否足够短，且无阻塞调用？
5. 是否区分了本地中断屏蔽与跨核互斥这两件事？
