# 第三方开源软件声明

本产品包含以下第三方开源软件。各组件的版权归其各自所有者，按其原始许可条款使用。

---

## Pi (pi-coding-agent)

- **项目地址**：https://github.com/earendil-works/pi
- **官方网站**：https://pi.dev/
- **采用版本**：v0.87.1（commit `8676a0dc`）
- **许可协议**：MIT License
- **使用方式**：源码形式包含于本产品 `vendor/` 目录，作为 Agent 运行时内核

### 许可证全文

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 合规要点（内部备忘）

1. **本文件必须随产品交付**，包含私有化部署包与 SaaS 服务的关于页面。这是 MIT 协议规定的唯一义务，缺失即构成违约。
2. **MIT 协议无传染性**，本产品自有代码可闭源、可商业售卖，无需公开源码。
3. **修改 Pi 源码不影响合规**，但仍须保留上述版权声明。建议在修改处以注释标注改动原因，便于追溯。
4. **协议不可撤销**：授权一经给出不可收回，上游项目的后续状态变化不影响本产品对已采用版本的永久使用权。
5. 新增任何第三方依赖时，须在本文件追加其许可声明。

> ⚠️ 免责声明条款意味着上游不对软件质量担责。本产品对客户的质量责任由本产品承担，故核心链路须有自有测试覆盖。
