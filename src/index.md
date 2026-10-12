# mdBook + Giscus 模板

这是一个基于 **mdBook** 和 **Giscus** 的静态文档/博客站点模板。

## 特性

- 📚 **mdBook**：快速构建静态文档站点
- 💬 **Giscus**：基于 GitHub Discussions 的评论系统（支持暗黑模式自动切换）
- 🔧 **Makefile**：简洁的构建命令
- 🌐 **GitHub Pages 友好**：可直接部署到 GitHub Pages

## 快速开始

### 1. 安装 mdBook

前往 [mdBook Release 页面](https://github.com/rust-lang/mdBook/releases)，根据操作系统下载对应的预编译二进制文件并安装。

```bash
# 或使用 cargo 安装
cargo install mdbook
```

如果需要固定 mdBook 版本，请参考 `.github/workflows/mdbook.yml` 文件。

### 2. GitHub Pages 部署

[示例](https://github.com/kern-crates/hugo-book-template/issues/1)。

使用 GitHub Actions 自动部署到 GitHub Pages：

1. **启用 GitHub Pages**  
   仓库 Settings → Pages → Source 选择 **GitHub Actions**

2. **推送 workflow 文件**  
   本模板已包含 `.github/workflows/mdbook.yml`，推送到仓库后即可自动运行

3. **查看部署结果**  
   Workflow 完成后，仓库 Settings → Pages 可查看部署后的网站

详细说明见 `src/how-to-contribute.md`。

### 3. 配置站点

#### 基础配置

修改 `book.toml`：
```toml
[output.html]
git-repository-url = "https://github.com/YOUR_USERNAME/YOUR_REPO"
edit-url-template = "https://github.com/YOUR_USERNAME/YOUR_REPO/edit/main/{path}"
```

#### 配置 Giscus 评论系统

[示例](https://github.com/kern-crates/hugo-book-template/issues/3)。

1. **安装 Giscus App**  
   前往 <https://github.com/apps/giscus> 安装该应用到你的目标仓库。

2. **启用 Discussions**  
   在仓库 Settings → Features 中启用 **Discussions**。

3. **获取配置信息**  
   访问 <https://giscus.app> 填写以下信息：
   - Repository: 你的仓库名（如 `username/repo-name`）
   - Category: 创建或选择一个讨论分类
   - Theme: 选择配色方案

4. **复制配置到 `giscus.js`**  
   从 giscus.app 获取的配置包含以下字段，填入 `giscus.js`：
   ```javascript
   script.setAttribute('data-repo', 'YOUR_USERNAME/YOUR_REPO');
   script.setAttribute('data-repo-id', 'REPO_ID');     // 从 giscus.app 获取
   script.setAttribute('data-category', 'General');    // 你创建的讨论分类
   script.setAttribute('data-category-id', 'CATEGORY_ID'); // 从 giscus.app 获取
   ```

🔍 提示：Category ID 和 Repo ID 也可以从仓库的 Discussion 页面 URL 或开发者工具中找到。

### 4. 本地预览

```bash
make serve
```

浏览器打开 <http://127.0.0.1:3001> 即可预览。

或者构建文档：

```bash
make build
```

生成的静态文件在 `public/` 目录。

### 5. 修改 README

仓库根目录的 `README.md` 符号链接到 `src/index.md`。

如需修改 README，请只编辑 `src/index.md`，从而部署网页与 README 同步。
