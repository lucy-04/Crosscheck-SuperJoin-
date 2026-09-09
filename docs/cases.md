# The four required cases

Captured verbatim from `npm run demo`. These are **selected by the reasoning
engine from its own output**, not hand-picked: the demo asks for the
highest-confidence example of each verdict, preferring cross-document pairs.
If the engine stops producing one, it prints an absence rather than a fixture.

Reproduce with no API key:

```bash
npm run demo
```

```text
Reconciling …
  0 facts canonicalised · 37 blocks · 140 pairs compared · 6 relations · 0.1s

Store: 226 grounded facts · 86 quarantined (72% grounding rate)
Vocabulary: {"predicate":150,"subject":19,"value":2}
Verdicts:   {"CONTRADICTS":1,"CORROBORATES":1,"RECONCILED":4}

──────────────────────────────────────────────────────────────────────────────
CASE 1 — A fact corroborated across documents, expressed differently
──────────────────────────────────────────────────────────────────────────────
Two sources state the same thing for the same scope. Wording, units and scale
may differ; after normalisation the values agree and every axis lines up.

  VERDICT: CORROBORATES  (rule R1b-boundary-period, confidence 0.74)
  AXIS:    period
  DECIDED: rule

  CLAIM A
    Delhivery · EBITDA = (4,516.08) million INR
    scope:    March 31, 2023, consolidated, segment:delhivery
    source:   Delhivery Annual Report Fy24 Excerpt p37 (published 2024-08-08)
    evidence: "EBITDA 1,266.41 (4,516.08)"

  CLAIM B
    Delhivery · ebitda = Rs. (452 Cr) crore INR
    scope:    FY23
    source:   Delhivery Q4 Fy24 Earnings Presentation p5 (published 2024-05-17)
    evidence: "a FY24 EBITDA increased by Rs. 578 Cr to Rs. 127 Cr from Rs. (452 Cr) in FY23"

  REASONING
    Both sources state the same value for the same measure. ₹-451.61 crore matches ₹-452 crore. March 31, 2023 [2023-03-31 → 2023-03-31] and FY23 [2022-04-01 → 2023-03-31] — one is stated as an instant falling exactly on the other's closing date, which is how filings often head an annual column. Treated as the same fact stated two ways; the period labelling is ambiguous, so confidence is reduced.

  AXIS-BY-AXIS
    --  period       March 31, 2023 [2023-03-31 → 2023-03-31] and FY23 [2022-04-01 → 2023-03-31] — one is stated as an instant falling exactly on the other's closing date, which is how filings often head an annual column
    OK  entityScope  Only one side declares an entity scope (consolidated); the other is unqualified, so they are treated as compatible
    OK  basis        Neither carries additional qualifiers
    OK  unit         Both normalise to INR
    OK  predicate    Both measure "EBITDA"
    --  vintage      Published 2024-08-08 and 2024-05-17 — the first is the later statement

──────────────────────────────────────────────────────────────────────────────
CASE 2 — A genuine or likely contradiction
──────────────────────────────────────────────────────────────────────────────
Same subject, measure, period, entity scope, basis and unit — and still different
values. Every reconciling hypothesis was tried and none fits.

  VERDICT: CONTRADICTS  (rule R8, confidence 0.9)
  DECIDED: rule

  CLAIM A
    Delhivery · revenue growth = 40% %
    scope:    FY24
    source:   Delhivery Q4 Fy24 Earnings Presentation p5 (published 2024-05-17)
    evidence: "5 TL: 40% YoY revenue growth with service EBITDA profitability improvement"

  CLAIM B
    Delhivery · revenue growth = 12.7% %
    scope:    FY24
    source:   Delhivery Q4 Fy24 Earnings Presentation p6 (published 2024-05-17)
    evidence: "YoY: 12.7%"

  REASONING
    Genuine disagreement. Both describe the same subject, measure, period, entity scope, basis and unit, yet state different values. 40% vs 12.7%.

  AXIS-BY-AXIS
    OK  period       Both cover FY24 [2023-04-01 → 2024-03-31]
    OK  entityScope  Neither declares an entity scope
    OK  basis        Neither carries additional qualifiers
    OK  unit         Both normalise to %
    OK  predicate    Both measure "revenue growth"
    OK  vintage      Both were published 2024-05-17

──────────────────────────────────────────────────────────────────────────────
CASE 3 — An apparent contradiction explained by context
──────────────────────────────────────────────────────────────────────────────
The values differ, but so does the scope, and the engine names which axis accounts
for the gap rather than simply labelling the pair.

  VERDICT: RECONCILED  (rule R4-period, confidence 0.85)
  AXIS:    period
  DECIDED: rule

  CLAIM A
    Delhivery Limited · express parcel shipments = >2.8Bn billion
    scope:    As of March 31, 2024
    source:   Delhivery Annual Report Fy24 Excerpt p2 (published 2024-08-08)
    evidence: ">2.8Bn >4.8Mn tonnes 15,065 753 98,135"

  CLAIM B
    Delhivery · express parcel shipments = 740 Mn mn
    scope:    FY24, segment:express parcel
    source:   Delhivery Q4 Fy24 Earnings Presentation p6 (published 2024-05-17)
    evidence: "740 Mn 1.4 Mn Tons"

  REASONING
    These look contradictory but are not: they describe different things. As of March 31, 2024 [2024-03-31 → 2024-03-31] and FY24 [2023-04-01 → 2024-03-31] — one is stated as an instant falling exactly on the other's closing date, which is how filings often head an annual column. Values: 2,800,000,000 count vs 740,000,000 count. Also differing: entityScope.

  AXIS-BY-AXIS
    --  period       As of March 31, 2024 [2024-03-31 → 2024-03-31] and FY24 [2023-04-01 → 2024-03-31] — one is stated as an instant falling exactly on the other's closing date, which is how filings often head an annual column
    --  entityScope  Different entity scope: unstated vs segment:express parcel — these cover different sets of entities
    OK  basis        Neither carries additional qualifiers
    OK  unit         Both normalise to count
    OK  predicate    Both measure "express parcel shipments"
    --  vintage      Published 2024-08-08 and 2024-05-17 — the first is the later statement

──────────────────────────────────────────────────────────────────────────────
CASE 4 — An extraction or reasoning failure, and how it is handled
──────────────────────────────────────────────────────────────────────────────
Grounding rejects any claim whose quote cannot be found on the page it cites,
or whose value does not appear inside that quote. Rejected claims are kept and
counted rather than deleted, so the error rate is measured rather than asserted.

  Rejections by reason: {"quote_lacks_context":47,"quote_not_found":27,"value_not_in_quote":12}

  [quote_lacks_context] Delhivery Limited · active routes = 834
     cited quote: "834"
     source:      Delhivery Annual Report Fy24 Excerpt p10
     handling:    dropped before reasoning; visible at /quarantine

  [quote_not_found] Delhivery Limited · mapped kitchens = 40
     cited quote: "40"
     source:      Delhivery Annual Report Fy24 Excerpt p10
     handling:    dropped before reasoning; visible at /quarantine

  [quote_lacks_context] Delhivery Limited · daily meals served = 1,200,000
     cited quote: "1,200,000"
     source:      Delhivery Annual Report Fy24 Excerpt p10
     handling:    dropped before reasoning; visible at /quarantine

──────────────────────────────────────────────────────────────────────────────
Run `npm run dev` to explore this interactively.
──────────────────────────────────────────────────────────────────────────────
```
