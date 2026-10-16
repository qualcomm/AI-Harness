### 执行测试
```powershell
# 语法检测
pnpm lint extensions/geniex
# 单元测试
pnpm test:extensions geniex
pnpm test:extensions geniex-manager
# ui单元测试 先生成语言包
pnpm ui:i18n:sync
pnpm --dir ui test
```
### openclaw.json需要enable此插件
```json
"plugins": {
    "entries": {
        "geniex" : {
            "enable": true
        }
    }
}
```

### 检查能不能发现geniex provider
```powershell
node openclaw.mjs models list --provider geniex --all
```

### 启动网关
```powershell
cmd /c "node openclaw.mjs gateway run --verbose > gateway.log 2>&1"
```