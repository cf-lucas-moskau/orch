# decisions

One file per needs-the-user event, `D-NN.md`, numbered upward. orch writes it before pushing.

```markdown
# D-NN: <question in one line>

- Session: <name> (<workspace>, <pane>)
- Opened: <YYYY-MM-DD HH:MM>
- Status: open | accepted | rejected | dropped
- Stakes: <what happens either way, what it touches (push, DB, outward)>
- Gates: <checks the session reported and their result, or "none reported">

## Options
1. <option>, the session's own proposal first
2. ...

## Recommendation
<orch's pick and why, one or two lines>

## Outcome
<the user's words verbatim, date, and what was relayed>
```

Close a decision as dropped when the session moved on without it (the user answered in the pane directly).
