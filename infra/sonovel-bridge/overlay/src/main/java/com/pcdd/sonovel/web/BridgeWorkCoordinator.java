package com.pcdd.sonovel.web;

import java.util.concurrent.Semaphore;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

public final class BridgeWorkCoordinator {

    private static final ReentrantReadWriteLock WORK_LOCK = new ReentrantReadWriteLock(true);
    private static final Semaphore CHECK_SLOTS = new Semaphore(3, true);

    private BridgeWorkCoordinator() {
    }

    public static void runCheck(CheckedRunnable action) throws Exception {
        Lock lock = WORK_LOCK.readLock();
        lock.lockInterruptibly();
        try {
            CHECK_SLOTS.acquire();
            try {
                action.run();
            } finally {
                CHECK_SLOTS.release();
            }
        } finally {
            lock.unlock();
        }
    }

    public static <T> T runDownload(CheckedSupplier<T> action) throws Exception {
        Lock lock = WORK_LOCK.writeLock();
        lock.lockInterruptibly();
        try {
            return action.get();
        } finally {
            lock.unlock();
        }
    }

    @FunctionalInterface
    public interface CheckedRunnable {
        void run() throws Exception;
    }

    @FunctionalInterface
    public interface CheckedSupplier<T> {
        T get() throws Exception;
    }
}
