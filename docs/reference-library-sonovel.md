# 参考书库与 SoNovel 集成

本分支为 Novel Forge 增加统一的参考书库，并以 SoNovel `v1.11.0` 作为搜索、验证和下载引擎。

## 功能变更

- 新增 `/reference-library` 页面，支持一次输入最多 20 位作者。
- 搜索结果按规范化作者和书名归并，只展示通过详情、目录及首尾章节验证的书籍。
- 同一书源的重复 URL 依次兜底，不重复保留；不同书源最多 3 路并行验证。
- 验证期间按书目持续更新进度和已找到结果，避免单作者任务长时间停在 0%。
- 支持批量下载、失败切源、任务恢复、EPUB 文件管理和重新导入。
- EPUB 按书脊顺序解析并创建 `reference_import` 类型知识文档，可直接进入拆书。
- 搜索和下载任务接入现有运行记录。

## 数据与接口

- Prisma 新增 `ReferenceSearchJob`、`ReferenceBook`、`ReferenceBookSource` 和 `ReferenceDownloadJob`。
- 新增 `/api/reference-library` 搜索、下载、书库、文件和重试接口。
- 新增 PostgreSQL 与 SQLite 正式迁移 `20260730143000_reference_library`。
- 显式引入 EPUB、XML 和 HTML 正文解析依赖。

## SoNovel Bridge

`infra/sonovel-bridge/overlay` 保存相对 SoNovel `v1.11.0` 的源码覆盖文件：

- `/book-check` 验证详情、目录和首尾章节。
- `/book-fetch` 接收 `taskId` 并返回下载元数据。
- 聚合搜索和下载遵循 `SONOVEL_DISABLED_SOURCE_IDS`。
- 下载独占执行；书目验证最多 3 路并行。
- 下载进度事件携带 `taskId`。

构建镜像：

```bash
git clone --branch v1.11.0 https://github.com/freeok/so-novel.git so-novel
cp -R infra/sonovel-bridge/overlay/. so-novel/
cp infra/sonovel-bridge/Dockerfile.bridge so-novel/Dockerfile.bridge
cd so-novel
mvn -DskipTests package
docker build -f Dockerfile.bridge -t sonovel-novel-forge:1.11.0-bridge1 .
```

建议仅将容器端口绑定到 `127.0.0.1:7765`，并设置：

```text
SONOVEL_DISABLED_SOURCE_IDS=3,9,11
JAVA_OPTS=-Dmode=web -Xms64m -Xmx512m
```

Novel Forge 服务端使用 `SONOVEL_BASE_URL` 指向该容器，默认值为 `http://127.0.0.1:7765`。

## 验证

- 服务端 TypeScript 构建通过。
- 已使用“唐家三少”完成搜索、下载、EPUB 入库和知识文档创建。
- 已使用“天蚕土豆”验证多书源归并；3 路并行优化需要部署新 bridge 镜像后复测耗时。
