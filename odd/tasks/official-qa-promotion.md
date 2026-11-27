# Official QA promotion
Integrate the tested fork candidate in review stages without publishing from a push.

## Specs
- S1: “listo hazlo y mandalo y apruebalo ya todo esta validado”
- S2: “Rama de integración con PRs por etapa (recomendado)”

## Tasks
- T1 · S1–S2 · inline · Create integration tracker and stage inherited prerequisites and producers · commit pending
- T2 · S1–S2 · inline + independent verifier · Require manual publication and bind the launcher to the official release bytes · commit pending
- T3 · S1–S2 · inline · Send tracker and stacked PRs; report review and verification status · commit pending

## Log
- L1: listo hazlo y mandalo y apruebalo ya todo esta validado
- L2: Rama de integración con PRs por etapa (recomendado)
- Evidence boundary: fork `fc956feba848`, upstream `f97d56d884b1`. Fork CI does not qualify new upstream commits. GitHub prohibits approval by the PR author.
