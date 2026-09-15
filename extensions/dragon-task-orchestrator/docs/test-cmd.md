### 检查语法问题
```powershell
pnpm tsgo
pnpm exec tsgo -- -p extensions/dragon-task-orchestrator/tsconfig.json
```

### 运行插件本身的unit-test
```powershell
./scripts/run-extension-tests-workaround.ps1
./scripts/run-extension-tests-workaround.ps1 -ExtensionId dragon-task-orchestrator
```

### 运行插件的UI test
```powershell
pnpm --dir ui test
pnpm --dir ui test -- task-orchestrator
```

### i18n同步
node --import tsx scripts/control-ui-i18n.ts sync --write

### 本地部署
```powershell
llama-server.exe -m "C:\Users\HCKTest\.cache\geniex\models\ggml-org\bge-m3-Q8_0-GGUF\bge-m3-q8_0.gguf" --embedding --pooling mean --port 8899 --alias bge-m3 -c 8192

llama-server.exe -m "C:\Users\HCKTest\.cache\geniex\models\unsloth\gpt-oss-20b-GGUF\gpt-oss-20b-F16.gguf" --jinja --port 18190 -c 16384 --alias unsloth/gpt-oss-20b-GGUF:F16

```
### 开始构建
```powershell
pnpm ui:build
pnpm build
```

### 启动网关
```powershell
cmd /c "node openclaw.mjs gateway run --verbose > gateway.log 2>&1"
```

### user prompt
将我的任务拆分为多个子任务。我计划国庆去河西走廊,你帮我搜索河西走廊的资料,我需要自驾从成都出发,输出一个合理的旅游攻略文档。
