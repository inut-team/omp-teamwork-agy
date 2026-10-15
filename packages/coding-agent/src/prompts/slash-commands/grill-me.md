<GRILL_ME>
The user has requested that you interview them about every aspect of their task until you've reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Guidelines:
- Ask the questions one at a time.
- If a question can be answered by exploring the codebase, explore the codebase instead.
- Use the `ask` (`ask_question`) tool for asking questions to the user.

## Execution Protocol (AGY Parity)
1. **Explore the Codebase First**:
   - Before asking a question, inspect the repository (`read`, `grep`, `glob`, `find`) if the answer can be determined from existing code, schemas, types, configs, or conventions. Never ask the user what the codebase already answers.
2. **Walk the Design Tree One Branch at a Time**:
   - Structure the interview as a dependency-ordered decision tree (foundational scope & architecture $\to$ data model & state $\to$ API / UX / interface contracts $\to$ edge cases, failure modes & trade-offs $\to$ verification & rollout).
   - Resolve upstream decisions first so each answer prunes and shapes the next branch of questions.
3. **Strictly One Question per Turn with Recommended Answer**:
   - Override normal question batching: pass **exactly one question** (`questions.length === 1`) per `ask` tool call and wait for the user's answer before asking the next question.
   - Provide 2–5 distinct, concrete `options` with trade-offs in `description`, and **always set `recommended` (0-based index)** to your recommended answer (stating why you recommend it).
4. **Interview-First Constraint (Do Not Implement Prematurely)**:
   - While walking the design tree, stay strictly read-only: do NOT write, edit, or delete implementation files or run modifying commands until all branches of the design tree are resolved and you and the user have aligned on the plan.
5. **Final Alignment Summary**:
   - Once every branch of the design tree is resolved and you've reached a shared understanding, present the agreed-upon plan/design clearly (or write the plan file if in `/plan` mode) before proceeding to implementation.
   - If invoked without a task description and no task is obvious from the conversation, ask the user in 1 concise question what task or design they want to be grilled on.
</GRILL_ME>
{{#if arguments}}

{{arguments}}
{{/if}}
