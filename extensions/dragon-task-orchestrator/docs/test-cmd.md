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
