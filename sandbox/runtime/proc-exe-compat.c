/* Linux 无 procfs 环境下的只读兼容层：从 ELF auxiliary vector 获取本进程真实
 * 可执行路径。仅兼容 /proc/self/exe 的 readlink，不挂载或读取宿主 procfs。
 * 浏览器仍运行于外层 PID / user / mount / network namespace 内。 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <unistd.h>
static ssize_t own_exe(char *buf, size_t size) {
    const char *source = (const char *)getauxval(AT_EXECFN);
    char resolved[PATH_MAX];
    if (!source || !realpath(source, resolved)) return -1;
    size_t length = strlen(resolved);
    if (length > size) length = size;
    memcpy(buf, resolved, length);
    return (ssize_t)length;
}
ssize_t readlink(const char *path, char *buf, size_t size) {
    ssize_t (*original)(const char *, char *, size_t) = dlsym(RTLD_NEXT, "readlink");
    if (strcmp(path, "/proc/self/exe") == 0) return own_exe(buf, size);
    return original(path, buf, size);
}
ssize_t readlinkat(int fd, const char *path, char *buf, size_t size) {
    ssize_t (*original)(int, const char *, char *, size_t) = dlsym(RTLD_NEXT, "readlinkat");
    if (strcmp(path, "/proc/self/exe") == 0) return own_exe(buf, size);
    return original(fd, path, buf, size);
}
