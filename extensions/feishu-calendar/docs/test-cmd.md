### 单元测试
pnpm test:extension feishu-calendar -- "extensions/feishu-calendar/test/*.test.ts"

### instruction
把【原始请求】里用户描述的时间范围/关键词，作为查询条件，调用 feishu_calendar_agenda 工具（start/end 参数）查询对应日期范围的日程。若原始请求没有明确说日期范围，默认查询从今天起未来 30 天。把结果里每条日程的时间、完整地点、主题列出来，不要编造。

### instruction-english
Use the keyword/date range described in the 【Original Request】 as the query condition, and call the feishu_calendar_agenda tool (with start/end parameters) to look up the agenda for that date range. If the original request doesn't specify a date range, default to querying the next 30 days starting from today. List the time, full location, and topic of every event in the results — do not fabricate anything.
