# dsh-observe design

The host DSH Web visual system is authoritative: native typography, UI primitives, light/dark tokens and conversation slots. This is an Operate surface for inspecting real executions.

The user explicitly requested reference to Context Insights and Trajectory. Preserve their strongest interaction principles: select a session, follow ordered requests/tool calls, inspect the actual content of one request in place. Avoid reproducing unrelated analytics charts.

The global surface has a searchable session navigator and execution workspace. Advanced identity filters and operational health are secondary, disclosed controls. The execution workspace has a compact chronological request/call list and a generous inspector, with Overview, Input/Output, Context, Tools, Source and Logs tabs. Empty metadata never occupies the primary reading space. Readable text and expandable structured values replace large metadata dumps.

Content comes from authenticated, read-only native Session observations. Show recorded content with credential redaction, lazy reads and explicit pagination. Reconstructed model-visible context has a native-log provenance label; unavailable plugin projections and missing wire-level HTTP data are stated honestly. Never call models or replay tools during inspection.

Rows use semantic model/tool/status cues, compact spacing and one clear selection. Desktop panes scroll independently. Narrow screens switch between call list and inspector. Keyboard focus, native theme contrast, visible loading/errors and no silent truncation are required.

Message headers show localized semantic badges (system, user, context, assistant, tool), matching native Trajectory. Only source.kind=user is human input; other user-role producers and developer messages are context. Preserve protocol role, source kind and form in collapsed source details. Unknown producer kinds remain context without guessing from body text. Context filters use the same classification before pagination.

Localize turns and steps in presentation without rewriting stored event labels. Operational log search must state that it searches captured diagnostic summaries, show scope counts independently of filters, distinguish an empty scope from no matches, and expose explicit all/unassociated scopes. Never infer session association from timing or message text.
