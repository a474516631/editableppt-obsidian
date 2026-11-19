---
title: Q3 Product Review
subtitle: Growth, retention and what we ship next
tags: [review, product]
---

# Q3 Product Review

Prepared for the leadership sync. Numbers are from the analytics export of 2 October. %%internal draft, do not share%%

## Highlights

- Weekly active users grew **18%** quarter over quarter
- Paid conversion moved from 2.1% to ==2.9%==
- Support tickets per 1,000 users fell to *4.2*
    - Median first response is now under two hours
    - The new help center deflects about a third of questions
- Shipped the editor rewrite, see [[Editor Rewrite#Rollout|the rollout notes]]

note: Open with the conversion number. It is the one the board asked about last time.

## Revenue by plan

| Plan | Customers | MRR | Change |
| :-- | --: | --: | :-: |
| Starter | 1,240 | $11,160 | +9% |
| Team | 386 | $18,914 | +22% |
| Business | 41 | $12,259 | +31% |
| Enterprise | 6 | $9,000 | flat |

Team overtook Starter as the largest plan by revenue for the first time.

## What users said

> [!quote] From the September survey
> I stopped exporting to slides by hand. The deck is just there when the note is done.

> We need better control over how long sections are split. Some of our notes are very long and the result ran to forty slides.

## Architecture change

The export now runs entirely on the device. Nothing is uploaded.

```ts
export async function exportNote(file: TFile) {
  const markdown = await app.vault.cachedRead(file);
  const deck = await buildDeck(markdown, options);
  await app.vault.adapter.writeBinary(target, deck.data);
}
```

## Dashboard

![[chart-growth.png]]

Growth was steady through August and picked up after the pricing page change in the second week of September.

## Screens

![[screen-a.png]]
![[screen-b.png|300]]

## Next quarter

### Must ship

1. Template picker with three built-in themes
2. Speaker notes from `note:` lines
3. Image handling on mobile

### Should ship

- [x] Tables as native PowerPoint tables
- [ ] Callout styling by type
- [ ] Per-note overrides in front matter

### Risks

The mobile build depends on an API that changed in the last release. If the fix slips, we hold the mobile launch and ship desktop first.

## 中文内容测试

这一页用来检查中日韩文字的换行和字号估算是否合理。演示文稿里的每一段文字都应当是可以直接修改的文本框，而不是一张图片。

- 第一条要点：标题和正文都应当使用系统里可用的中文字体
- 第二条要点：较长的句子需要在文本框里自动换行，而且不能超出幻灯片的下边界，否则导出的结果就没有办法直接使用
- 行内公式 $E = mc^2$ 和 `inline code` 也要保留下来

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

## Long section that must be split

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.

Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.

Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem.

Ut enim ad minima veniam, quis nostrum exercitationem ullam corporis suscipit laboriosam, nisi ut aliquid ex ea commodi consequatur? Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur, vel illum qui dolorem eum fugiat quo voluptas nulla pariatur?

- At vero eos et accusamus et iusto odio dignissimos ducimus
- Qui blanditiis praesentium voluptatum deleniti atque corrupti
- Quos dolores et quas molestias excepturi sint occaecati cupiditate
- Similique sunt in culpa qui officia deserunt mollitia animi
- Id est laborum et dolorum fuga, et harum quidem rerum facilis
- Est et expedita distinctio, nam libero tempore, cum soluta nobis
- Eligendi optio cumque nihil impedit quo minus id quod maxime
- Placeat facere possimus, omnis voluptas assumenda est

## Thank you

Questions: product@example.com
