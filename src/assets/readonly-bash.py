"""只读 Bash launcher。只允许登记的调用；不支持的环境在 exec 前退出。"""
import ctypes
import errno
import json
import os
import platform
import resource
import stat
import sys

ALLOW = 0x7FFF0000
DENY = 0x00050000 | errno.EPERM
MASKED_EQ = 7


class Compare(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("mask", ctypes.c_uint64), ("value", ctypes.c_uint64)]


# 默认拒绝，避免新系统调用或遗漏的变更入口自动获得权限。
# write 系列仅能使用已打开的 FD：父执行器必须提供管道，额外 FD 在加载前关闭。
ALLOWED = """
read readv pread64 preadv preadv2 write writev pwrite64 pwritev pwritev2 close close_range
lseek stat fstat lstat newfstatat statx access faccessat faccessat2 getdents getdents64
readlink readlinkat statfs fstatfs getxattr lgetxattr fgetxattr listxattr llistxattr flistxattr
dup dup2 dup3 fcntl flock pipe pipe2 poll ppoll select pselect6
mmap mprotect munmap mremap madvise brk mincore msync membarrier
rt_sigaction rt_sigprocmask rt_sigreturn rt_sigpending rt_sigtimedwait rt_sigsuspend sigaltstack
fork vfork execve execveat wait4 waitid exit exit_group
getpid getppid gettid getpgrp getpgid getsid setpgid setsid
getuid geteuid getgid getegid getresuid getresgid getgroups
set_tid_address set_robust_list get_robust_list futex futex_waitv rseq arch_prctl
getrlimit getrusage times sysinfo uname getcwd chdir fchdir umask
clock_gettime clock_getres gettimeofday time nanosleep clock_nanosleep sched_yield
sched_getaffinity sched_getparam sched_getscheduler sched_get_priority_max sched_get_priority_min getcpu
getrandom restart_syscall prctl seccomp
connect bind listen accept accept4 getsockname getpeername getsockopt setsockopt
sendto sendmsg sendmmsg recvfrom recvmsg recvmmsg shutdown
epoll_create epoll_create1 epoll_ctl epoll_wait epoll_pwait epoll_pwait2
eventfd eventfd2 timerfd_create timerfd_settime timerfd_gettime
timer_create timer_settime timer_gettime timer_getoverrun timer_delete
signalfd signalfd4 memfd_create
""".split()


def restrict_filesystem(roots):
    """Landlock 按 inode 授权写入；不会因为改变 HOME、符号链接或子解释器而失效。"""
    libc = ctypes.CDLL(None, use_errno=True)
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 3:
        raise RuntimeError("需要 Landlock ABI 3+ 才能安全开放本 Run 材料和缓存目录")
    # 处理全部文件变更，包括跨目录 rename/link 及 O_TRUNC。
    handled = sum(1 << bit for bit in range(1, 15) if bit not in (2, 3))
    class Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]
    class PathBeneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]
    attr = Ruleset(handled)
    ruleset = libc.syscall(444, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if ruleset < 0:
        raise RuntimeError("Landlock 规则集创建失败")
    try:
        # 不授予设备节点创建权限。/dev/null 仅允许写入/截断，不能删除或替换。
        for name in roots + ["/dev/null"]:
            fd = os.open(name, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                mode = os.fstat(fd).st_mode
                if name == "/dev/null":
                    if not stat.S_ISCHR(mode):
                        raise RuntimeError("/dev/null 不是字符设备")
                    access = (1 << 1) | (1 << 14)
                else:
                    if not stat.S_ISDIR(mode) or os.path.realpath(name) != name:
                        raise RuntimeError("可写目录不能是符号链接")
                    access = handled & ~((1 << 6) | (1 << 11))
                rule = PathBeneath(access, fd)
                if libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0) != 0:
                    raise RuntimeError("Landlock 目录授权失败")
            finally:
                os.close(fd)
        if libc.prctl(38, 1, 0, 0, 0) != 0 or libc.syscall(446, ruleset, 0) != 0:
            raise RuntimeError("Landlock 规则加载失败")
    finally:
        os.close(ruleset)


def install(roots=None):
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("当前只支持 Linux x86_64")
    if os.geteuid() == 0:
        raise RuntimeError("必须使用普通用户运行只读 Bash")
    for fd in (1, 2):
        # Node/libuv 的 stdio: pipe 在 Linux 上可使用 Unix socketpair。
        mode = os.fstat(fd).st_mode
        if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
            raise RuntimeError("输出必须使用父执行器管道")
    os.closerange(3, min(resource.getrlimit(resource.RLIMIT_NOFILE)[0], 2147483647))
    if roots is not None:
        restrict_filesystem(roots)
    lib = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                          ctypes.c_uint, ctypes.POINTER(Compare)]
    lib.seccomp_rule_add_array.restype = ctypes.c_int
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_load.restype = ctypes.c_int
    ctx = lib.seccomp_init(DENY)
    if not ctx:
        raise RuntimeError("seccomp 初始化失败")

    def rule(name, comparisons=(), action=ALLOW):
        number = lib.seccomp_syscall_resolve_name(name.encode())
        # 名称表没有该调用时，不放行；不能因此退回默认允许。
        if number < 0:
            return
        array = (Compare * len(comparisons))(*comparisons) if comparisons else None
        if lib.seccomp_rule_add_array(ctx, action, number, len(comparisons), array) != 0:
            raise RuntimeError("seccomp 规则构造失败：" + name)

    try:
        for name in ALLOWED:
            rule(name)
        if roots is None:
            flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND | 0x400000
            rule("open", (Compare(1, MASKED_EQ, flags, 0),))
            rule("openat", (Compare(2, MASKED_EQ, flags, 0),))
        else:
            # 路径权限由 Landlock 执行；seccomp 继续拒绝 chmod/chown/xattr、提权及逃逸入口。
            for name in ("open openat creat mkdir mkdirat unlink unlinkat rmdir rename renameat renameat2 "
                         "link linkat symlink symlinkat truncate ftruncate fsync fdatasync").split():
                rule(name)
        # 不允许创建新命名空间；clone3 的参数结构无法检查，返回 ENOSYS 让 libc 回退 clone。
        rule("clone", (Compare(0, MASKED_EQ, 0x7E020000, 0),))
        rule("clone3", action=0x00050000 | errno.ENOSYS)
        rule("prlimit64", (Compare(0, 4, 0, 0),))  # 仅当前进程。
        # 开放 IPv4/IPv6 socket，不开放宿主 Unix socket；这不是网络只读策略。
        for family in (2, 10):
            rule("socket", (Compare(0, 4, family, 0),))
        # Node 子进程的 stdio 管道使用私有 socketpair；不能据此连接宿主已存在的 Unix socket。
        rule("socketpair", (Compare(0, 4, 1, 0),))
        # libuv 为继承的 stdio socket 设置非阻塞/close-on-exec；只开放标准 FD 的这些操作。
        for fd in (0, 1, 2):
            for request in (0x5421, 0x5450, 0x5451, 0x5401, 0x5413, 0x541B):
                rule("ioctl", (Compare(0, 4, fd, 0), Compare(1, 4, request, 0)))
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(38, 1, 0, 0, 0) != 0:
            raise RuntimeError("无法设置 no_new_privs")
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError("内核拒绝只读 seccomp 规则")
    finally:
        lib.seccomp_release(ctx)


def main():
    try:
        roots = None
        if len(sys.argv) == 5 and sys.argv[1] == "--writable-roots":
            roots = json.loads(sys.argv[2])
            if not isinstance(roots, list) or not roots or len(roots) > 4 or any(
                    not isinstance(root, str) or not os.path.isabs(root) for root in roots):
                raise RuntimeError("目录授权参数无效")
            sys.argv = [sys.argv[0]] + sys.argv[3:]
        if len(sys.argv) != 3 or sys.argv[1] not in ("--probe", "--command"):
            raise RuntimeError("启动参数无效")
        install(roots)
    except Exception as error:
        print("[readonly-bash] 只读权限不可用，拒绝执行：" + str(error), file=sys.stderr)
        return 125
    if sys.argv[1] == "--probe":
        os.execv("/usr/bin/true", ["true"])
    os.execv("/bin/bash", ["bash", "--noprofile", "--norc", "-c", sys.argv[2]])


if __name__ == "__main__":
    sys.exit(main())
