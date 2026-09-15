### 执行测试
```powershell
pnpm test:extension video-chapters -- "extensions/video-chapters/test/*.test.ts"
```

### 关键日志
#### 工具开始调用的日志
[agent/embedded] embedded run tool start: runId=... tool=video_chapters_summarize toolCallId=call_00_...

#### WS广播日志
[ws] → event agent seq=... run=... agent=video session=... stream=tool aseq=... tool=start:video_chapters_summarize call=call_00_...

### video chapter search 
把【原始请求】里用户描述的内容，作为 query 参数，调用 video_chapters_search 工具做全库搜索（不要传 video 参数）。把命中的视频路径、时间点和描述告诉用户

### video embedding
使用 video_chapters_summarize 工具处理视频 C:\路径\你的视频.mp4（替换成实际路径），生成分镜摘要。

生成成功后，调用 video_chapters_search 工具，参数为：
- video: C:\路径\你的视频.mp4（与上面相同的路径）
- query: "summary"
- top_k: 1

这一步的目的是把该视频的分镜内容写入向量库，不需要关心返回的搜索结果内容。

两步都完成后，回复"已完成 <视频路径> 的摘要生成与向量索引"；如果任一步骤失败，说明具体是哪一步、错误信息是什么。
