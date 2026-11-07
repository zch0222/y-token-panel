# Y Token Panel

参考 CC Switch 用量统计模板实现的 CodeBuddy CLI 本地 Token 用量面板。使用 Next.js、Tailwind CSS、shadcn/ui 和 Recharts。

## 功能

- 读取本机 CodeBuddy CLI 会话 JSONL，展示真实 Token、Credits 和缓存用量
- 当天、昨天、近 7 天、近 30 天和全部时间筛选
- 按项目、供应商、模型组合筛选
- 请求数、Tokens、Credits、缓存命中率趋势图（柱状图 / 面积图）
- 请求日志、供应商、模型和项目聚合表格
- 请求详情、分页、CSV 导出、自动刷新、深色 / 浅色主题

## 启动

要求 Node.js 20.9 或更高版本。

~~~bash
npm install
npm run dev
~~~

打开 <http://127.0.0.1:3000>。

## 数据源

默认读取：

~~~text
~/.codebuddy/projects/<project>/*.jsonl
~~~

可以通过 **CODEBUDDY_DATA_DIR** 指定另一个 CodeBuddy projects 目录：

~~~powershell
$env:CODEBUDDY_DATA_DIR="D:\path\to\projects"
npm run dev
~~~

应用只提取时间、项目、模型和用量元数据，不读取或返回对话正文。开发和生产启动脚本默认只监听 127.0.0.1；不要将本地用量接口直接暴露到公网。

## 统计口径

- **请求数**：包含用量字段的 CodeBuddy API 调用记录数。
- **总 Tokens**：优先使用原始 total_tokens。CodeBuddy 的输入 Tokens 已包含缓存读取，因此不会再次累加缓存 Tokens。
- **缓存命中率**：缓存读取 Tokens ÷ 输入 Tokens。
- **Credits**：原始 credit 字段的合计，不是美元金额；缺失时显示为 —。
- **成功率**：根据会话记录状态统计，不推测日志中没有的 HTTP 状态码、首字时间或生成速度。

## 检查

~~~bash
npm run lint
npm run typecheck
npm run build
~~~
