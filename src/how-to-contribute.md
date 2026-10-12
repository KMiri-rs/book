# 贡献指南

## 添加新章节

mdBook 通过 `src/SUMMARY.md` 管理目录结构，**必须先修改 SUMMARY.md，再创建对应文件**。

**第一步：在 `src/SUMMARY.md` 中添加条目**

```diff
 - [首页](./index.md)
+  - [新主题](./new-topic/index.md)
+    - [第一篇](./new-topic/first.md)
 - [贡献指南](./how-to-contribute.md)
```

缩进表示层级关系，子章节用两个空格缩进。

**第二步：创建对应的 Markdown 文件**

```bash
mkdir src/new-topic
touch src/new-topic/index.md src/new-topic/first.md
```

文件内容示例：

```markdown
# 新主题标题

章节内容……
```

**第三步：本地预览确认**

```bash
make serve
```

`make serve` 运行期间修改文件会自动重新构建，无需重启。

## 修改 README

仓库根目录的 `README.md` 符号链接到 `src/index.md`。

如需修改 README，请只编辑 `src/index.md`，从而部署网页与 README 同步。
