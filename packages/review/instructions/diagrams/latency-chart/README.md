# Latency chart

Two weeks of checkout latency around a bad deploy, as a line chart and a bar chart that each step redraws to point at what it is about.

## Use when

The evidence is a number over time or across categories: a regression, a capacity limit, an error rate by endpoint. The chart makes the case and the code link shows where the data comes from.

## Shows

- A line chart of p50 and p95 by day, labelled at the line ends, with a tip on hover.
- A bar chart of p95 by endpoint on the worst day.
- Steps: the two weeks, the regression window, the endpoint that caused it, the revert.

## Technique

`wb.chart({ plot })` returns ordinary Observable Plot options and redraws on every step, so `plot` reads `frame.key` to add a wash, a rule or an emphasis. The stage supplies the palette in fixed order; the script colours text with `colors.ink` and `colors.muted`, never with a series colour. The charts are placed by hand, so `block.json` gives `stage.width` and `stage.height`.

## Adapt

- One axis per chart: two measures of different scale get two charts.
- Label series directly and keep the legend; never a number on every point.
- Name the query or code that produces the data in `code`.
