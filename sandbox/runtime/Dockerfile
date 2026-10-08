# 生产构建时用已审核的 digest 替换 BASE_IMAGE 的默认 tag。
ARG BASE_IMAGE=cube-sandbox-int.tencentcloudcr.com/cube-sandbox/sandbox-code:latest
FROM ${BASE_IMAGE}
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/tao-browsers \
    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MPLBACKEND=Agg
COPY sandbox/runtime/requirements.txt /opt/tao/requirements.txt
RUN python3 -m venv /opt/tao-venv \
    && /opt/tao-venv/bin/pip install --no-cache-dir -r /opt/tao/requirements.txt \
    && /opt/tao-venv/bin/python -m playwright install --with-deps chromium
ENV PATH=/opt/tao-venv/bin:/usr/local/bin:/usr/bin:/bin
COPY sandbox/runtime/worker.py /opt/tao/worker.py
RUN mkdir -p /workspace/inputs /workspace/output /workspace/downloads
# 保留官方镜像的 envd 启动入口；Tao 按需通过官方 SDK 启动 worker。
