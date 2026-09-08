**Superjoin** 

VIT 2026 · Engineering Intern 

# Engineering Intern Hiring Assignment 

This assignment is intentionally open-ended. We want to see how you explore an unfamiliar problem and turn your ideas into something that works. 

- Use any language, framework, database, LLM, coding agent, or library. 

- We care more about your approach and creativity than production-level polish. 

- Be honest about what works, what does not, and what you would improve. 

## **The Challenge: Build a Fact Knowledge Layer** 

Important facts are often scattered across documents, stated in different ways, supported by other evidence, or contradicted elsewhere. 

You will receive **three PDFs as a starter dataset** . Build a system that: 

- extracts meaningful numerical or semantic facts; 

- links every fact to evidence in its source document; and 

- identifies when facts corroborate, contradict, or can be reconciled through context. 

Provide a simple **API or UI** through which we can upload PDFs and inspect the results. We may test your solution with additional PDFs, so it should not rely on hard-coded facts, filenames, schemas, or document-specific rules. 

The documents should guide what counts as a fact and how it is represented. Your schema, storage, interface, and output format are entirely up to you. 

**A graph database or visualization alone is not the solution.** The interesting part is how facts are discovered, grounded, compared, and explained. 

### **Show Us These Four Cases** 

Your submission should include at least one example of each: 

1. A fact corroborated across documents, even if expressed differently. 

2. A genuine or likely contradiction. 

3. An apparent contradiction explained by context, such as time, scope, or units. 

4. An extraction or reasoning failure you found and how you handled—or would improve—it. 

Show the source evidence and your system's reasoning for the first three. 

For inspiration, two revenue figures may differ because they cover different periods; a director may appear active in one document and resigned in a later one; or differently written addresses may refer to the same place. These are examples, not a required data model or checklist of facts. 

1 


## **What We Are Looking For** 

- A thoughtful and creative approach. 

- Useful facts that are grounded in the PDFs. 

- Sensible handling of ambiguity, context, and uncertainty. 

- A solution that can generalize beyond the starter documents. 

- Clear engineering decisions and trade-offs. 

We do not expect perfect extraction or a production-ready system. A smaller, understandable prototype is better than a large system whose behavior is unclear. 

## **Brownie Points** 

If the core experience works, try extending it to handle: 

- large PDFs without significant performance issues; 

- many PDFs in the same knowledge layer; 

- a schema that evolves dynamically as new kinds of facts appear; or 

- new documents incrementally, without rebuilding all existing knowledge. 

These are suggestions, not additional requirements. Feel free to explore another extension that meaningfully improves the core system. 

## **Submission** 

Use git meaningfully and create a GitHub repository for your solution. Include the following sections in your **README.md** : 

|**Setup and Run Instructions**|Tell us how to run your project.|
|---|---|
|**Video Demo**|Link to a demo video of**3 minutes or less**showing a PDF being processed<br>and the four required cases above.|
|**Approach**|Explain your approach, architecture, important decisions, trade-offs, and the AI tools you used.|
|**Limitations and Next Steps**|Tell us what does not work yet and what you would build next.|
|**Additional Notes**|Add anything else you would like us to know.|



Keep credentials out of the repository. If the project requires a paid service, include enough sample output and video footage for us to evaluate it without needing your account. 

Submit your GitHub repository link and demo video link through the form: **https://forms.gle/3fLdBQ2D6Zm2Gqtv7** 

### **Before You Submit** 

- The project runs from my instructions and accepts new PDFs through an API or UI. 

- Results contain facts, source evidence, and cross-document relationships. 

- I demonstrate the four required cases. 

- I have documented my approach and included a demo video of 3 minutes or less. 

Most importantly, have fun tinkering. We are excited to see how you think. 

2 

