# noxeval

**Avalie apps de LLM em que dá para confiar.** Verificações determinísticas primeiro, um juiz opcional depois, e as ferramentas para conferir o juiz: erros plantados e correção humana às cegas, com kappa de Cohen.

[Read in English](README.md)

![noxeval rodando no terminal: cinco casos, uma falha explicada e o resumo com placar, juiz e erros plantados](https://raw.githubusercontent.com/marcusrdrigues/noxeval/main/docs/assets/noxeval-run.png)

<sub>O exemplo da livraria com um juiz de demonstração. Na CI e em logs, a mesma rodada sai em texto puro.</sub>

## Por quê

A maioria das avaliações de LLM termina num número dado por outro LLM. É difícil confiar nesse número: o juiz também é um modelo, pode ser enganado pela mesma injeção de prompt que está avaliando, e "o juiz deu 95%" não diz se o juiz está certo.

O noxeval empilha três camadas, cada uma conferindo a anterior:

1. **Verificações determinísticas.** Termos obrigatórios, termos e padrões proibidos, recusa, idioma da resposta, links fora de uma lista permitida, imagem em Markdown (rota clássica de exfiltração), marcadores de vazamento do prompt, tamanho. Rígidas e reproduzíveis: quando uma falha, a mensagem diz exatamente o que faltou.
2. **Um juiz opcional** para o que regra não vê: fato que o contexto não sustenta, negar uma informação que o contexto tem, aceitar uma premissa falsa da pergunta. Cada veredito é cruzado com as verificações, e as discordâncias são listadas para você ler.
3. **Uma conferência do juiz.** _Erros plantados_ (respostas erradas de propósito, óbvias e sutis) medem se o juiz reprova o que está errado. A _correção às cegas_ no terminal deixa você corrigir as respostas sem ver veredito nenhum e mede a concordância do juiz com você pelo kappa de Cohen.

Em volta delas, um **portão de regressão** para equipes que mudam prompt, modelo ou busca toda semana: cada rodada é comparada com a última que você aceitou e só falha quando algo piorou. Falhas já conhecidas continuam listadas, em vez de deixar toda rodada vermelha.

Foi construído para o [Nox](https://marcusrdrigues.com), o chat com RAG do portfólio do autor, e extraído para qualquer app de LLM usar. A versão 0.6 veio da adoção num segundo app, um assistente jurídico com RAG escrito em Java.

## Começando

Precisa do Node.js 22.18 ou mais novo. Sem dependências de runtime.

```bash
npm install --save-dev noxeval
npx noxeval init     # cria noxeval.config.mjs, noxeval.cases.json e noxeval.planted.json
```

Aponte o alvo para o seu app em `noxeval.config.mjs`:

```js
import { defineConfig, httpTarget } from "noxeval";

export default defineConfig({
  target: httpTarget({ url: "http://localhost:3000/api/chat", answerPath: "answer", contextPath: "context" }),
  cases: "./noxeval.cases.json",
  checks: { allowedLinks: ["example.com"], leakMarkers: ["You are Ava"] },
});
```

```bash
npx noxeval run      # grava noxeval-report.json; sai com 1 se algum caso falhar
```

### Testar sem um app

O repositório tem um app falso pequeno, com um bug de propósito:

```bash
git clone https://github.com/marcusrdrigues/noxeval && cd noxeval
npm install && npm run build
node examples/bookstore/server.mjs &
npx noxeval run -c examples/bookstore/noxeval.config.mjs
```

O `examples/recorded` nem precisa de servidor: são respostas gravadas num arquivo por um assistente de direito do consumidor, e uma delas cita uma fonte que nunca recebeu.

```bash
npx noxeval run -c examples/recorded/noxeval.config.mjs
```

## Casos

O arquivo de casos é JSON: frases de recusa por idioma e a lista de casos. Os campos (`id`, `question`, `locale`, `expect`, `mustInclude`, `mustNotInclude`, `mustNotMatch`, `refusal`, `history`, `category`, `tags`, e os da 0.6: `mustCite`, `mustNotCite`, `citations`, `maxCostUsd`, `maxLatencyMs`) estão explicados na [tabela do README em inglês](README.md#cases). O arquivo é validado antes de qualquer chamada, e todos os problemas aparecem de uma vez.

`mustInclude` é uma lista de grupos: cada grupo precisa casar com um dos seus termos, sem diferenciar acento, aspas tipográficas e maiúsculas. `[["Java", "Kotlin"], ["backend"]]` quer "Java ou Kotlin" e "backend".

## Alvos

- `httpTarget({ url, answerPath?, contextPath?, sourcesPath?, toolCallsPath?, costPath?, msPath?, headers?, body?, timeoutMs? })` faz POST de `{ question, locale, history }` (ou do seu `body(case)`) e lê a resposta num caminho do JSON, ou o corpo inteiro como texto. `contextPath` lê o que o modelo recebeu, que o juiz usa.
- `functionTarget(nome, async (c) => ({ answer, context, sources, toolCalls, costUsd, ms }))` para o resto: stream, SDK, chamada direta no mesmo processo.
- `jsonlTarget(arquivo)` corrige [respostas que o seu app gravou](#respostas-gravadas), para apps em qualquer linguagem e sem endpoint de teste.
- `sourcesPath` / `sources`: as fontes com seus ids, para as [citações](#citações). `toolCallsPath` / `toolCalls`: as chamadas de ferramenta de um agente, para as [verificações de trajetória](#avaliando-agentes). `costPath` / `costUsd` e `msPath` / `ms`: quanto a resposta custou e quanto o app levou, para os [limites](#custo-e-latência).

## Avaliando agentes

Um app com ferramentas pode acertar a resposta pelo caminho errado: chamar uma ferramenta que não devia, chamar a certa com o argumento errado, ou pular a ferramenta e responder com contexto incompleto. As verificações de trajetória olham as chamadas que o app fez, junto das verificações da resposta.

O alvo informa as chamadas: `httpTarget({ ..., toolCallsPath: "toolCalls" })` lê `{ name, args }`, `{ name, arguments }` ou o formato da OpenAI `{ function: { name, arguments } }`; um `functionTarget` devolve `toolCalls`. Devolva `[]` quando nenhuma ferramenta foi chamada: campo ausente quer dizer "não dá para conferir", e o caso falha com `no-trajectory` em vez de passar sem conferência.

Campos (detalhes na [tabela em inglês](README.md#evaluating-agents)): `mustCallTool`, `mustNotCallTools`, `forbiddenTools` (falha de segurança), `toolArgs`, `toolArgsWhenCalled` (se chamou, foi com estes argumentos) e `maxToolCalls` (falha de segurança).

Três lições do primeiro agente avaliado com o noxeval: exija ferramenta só quando o contexto não responde (listas precisam, um fato que já está nos trechos não); use `toolArgsWhenCalled` em perguntas sobre um documento inteiro; e coloque o resultado das ferramentas em `context`, para o juiz avaliar a resposta contra o que as ferramentas devolveram. `failureKind(code)` separa falhas de segurança das de utilidade.

## Variação

Modelo não é determinístico: uma rodada diz "passou" ou "falhou", mas a verdade é uma taxa. `noxeval run --repeat 5` (ou `repeat: 5` na configuração) pergunta cada caso cinco vezes e decide por uma regra só:

- **Falha de segurança em qualquer tentativa reprova o caso** (vazamento, link de fora, recusa que faltou, ferramenta proibida, limite de chamadas). Um vazamento em cinco respostas é problema de verdade, não ruído.
- **Falhas de utilidade são comparadas com `minPassRate`** (na configuração ou no caso; padrão `1`, ou seja, todas as tentativas precisam passar). Use `0.8` num caso em que uma regra de estilo, como tamanho, escapa de vez em quando.

O relatório traz, por caso, todas as tentativas, `passRate` e `passRateLow`: o limite inferior do intervalo de Wilson de 95%, que deixa uma amostra pequena honesta (5 de 5 só diz que a taxa real provavelmente passa de 57%). Casos que passaram em algumas tentativas e falharam em outras aparecem como `flaky`. O juiz e a correção às cegas usam só a primeira tentativa.

## Detalhe sem fonte

Num app com RAG, o erro mais caro é um fato que o modelo inventou: um ano, um valor, uma empresa que não está no seu conteúdo. `noxeval run --grounding report` (ou `checks: { grounding: "report" }`) confere cada **número, sigla e nome próprio** da resposta contra o contexto que o alvo devolveu (`contextPath` no `httpTarget`). Sem modelo: é uma regra, barata e explicável.

- **`report`** só mede, sem reprovar caso. Comece por ele e leia as respostas marcadas antes de confiar na regra.
- **`check`** reprova o caso com `ungrounded`, uma falha de utilidade (com `--repeat`, comparada com `minPassRate`).
- `groundingAllow` lista os nomes que a resposta sempre pode dizer (o do assistente, o da pessoa ou empresa do app). Um caso pode pular a checagem com `"grounding": false`.
- Resposta sem contexto aparece como **não conferida**, nunca como sustentada.

As regras vieram de rodar isso num assistente de verdade (o [Nox](https://marcusrdrigues.com/nox)): "10 mil", "10.000" e "dez mil" são o mesmo número; o detalhe da pergunta só passa numa frase que nega; e conta com datas à vista não é invenção ("entrou em 2023, saiu em 2026, 3 anos depois"). Confere detalhe, não sentido: "trabalhou" virando "liderou" passa, e isso é trabalho do juiz.

## Citações

Um app com RAG que cita os trechos por id (`[cdc-art-6]`) pode ser conferido sem modelo: o alvo informa **quais fontes deu ao modelo, com os ids**, e o noxeval lê os ids que a resposta cita. Nada muda no funcionamento do app.

```json
{
  "id": "produto-com-defeito",
  "question": "O liquidificador quebrou em uma semana. A loja pode se recusar a consertar?",
  "mustCite": [["cdc-art-18"], ["sumula-297", "sumula-302"]],
  "mustNotCite": ["trecho-envenenado"]
}
```

- **`citation-unknown`**: a resposta cita um id que não estava entre as fontes, ou seja, inventou a fonte. É **falha de segurança**: com `--repeat`, basta uma tentativa para reprovar o caso.
- **`citation-forbidden`**: cita um id de `mustNotCite` (um trecho envenenado de propósito, por exemplo). Também é falha de segurança.
- **`citation-missing`**: algum grupo de `mustCite` não foi citado. Cada grupo precisa de um dos seus ids, como no `mustInclude`.
- **`no-sources`**: o caso tem `mustCite` e o alvo não informou fontes. Reprova em vez de passar sem conferência.

O padrão lê `[id]`, `[3]` e `[a][b]` e ignora links em Markdown (`[aqui](https://...)`); troque com `checks: { citations: { pattern: "..." } }`. `"citations": false` pula a checagem num caso (uma recusa não cita nada). Sem `context`, o texto das fontes vira o contexto, e o [detalhe sem fonte](#detalhe-sem-fonte) e o juiz continuam funcionando. Confere o id, não se o trecho sustenta a frase: isso é trabalho do juiz.

## Respostas gravadas

O `jsonlTarget` corrige um arquivo que o seu app gerou pelo próprio caminho de código (prompts, adapters e cache de verdade), com um objeto JSON por linha. O app pode ser em Java, Python ou qualquer linguagem, não precisa de endpoint de teste, e o noxeval não faz nenhuma chamada de rede.

```jsonl
{
  "id": "produto-com-defeito",
  "answer": "Não. A loja tem 30 dias para consertar [cdc-art-18].",
  "sources": [
    {
      "id": "cdc-art-18",
      "text": "..."
    }
  ],
  "ms": 912,
  "costUsd": 0.0021
}
```

```js
target: jsonlTarget(new URL("./answers.jsonl", import.meta.url)),   // relativo ao arquivo de configuração
```

- Caso sem linha falha com `no-answer`. Com `--repeat`, as linhas de um caso são usadas em ordem, uma por tentativa; tentativa sem linha também é `no-answer`, porque reusar uma linha contaria uma resposta como várias amostras.
- Arquivo quebrado para a rodada antes do primeiro caso e lista todos os problemas com o número da linha. Arquivo com BOM e quebra de linha do Windows funciona.
- Ids do arquivo sem caso correspondente aparecem como nota no relatório: quase sempre é erro de digitação.
- Linha sem `ms` fica como "não medida": ler um arquivo não leva tempo, e isso não é a latência do app.

## Custo e latência

Uma mudança pode deixar o app mais lento ou mais caro sem deixar nenhuma resposta errada. O alvo informa quanto cada resposta custou, e você define limites:

```js
target: httpTarget({ url, answerPath: "answer", costPath: "usage.costUsd", msPath: "timing.appMs" }),
checks: { maxCostUsd: 0.01, maxLatencyMs: 4000 },   // um caso pode ter o próprio maxCostUsd / maxLatencyMs
```

- Resposta acima do limite falha com `over-cost` ou `over-latency`, falhas de utilidade (com `--repeat`, comparadas com `minPassRate`).
- O noxeval nunca adivinha preço: o `costUsd` vem do app (tokens do modelo e o que mais custar por resposta, como o embedding da pergunta). Sem ele, o limite aparece como **não conferido**, nunca como dentro.
- `msPath` / `ms` é o tempo dentro do app, sem a rede; sem ele, o noxeval mede a requisição inteira.
- O relatório traz o custo total da rodada (todas as tentativas), a média e o p90 por resposta, e a latência p95.

## Juízes

```js
import { jevJudge, openaiJudge } from "noxeval";

judge: jevJudge(),                                   // TYPESAFE_API_KEY
judge: openaiJudge({ model: "<id fixado do modelo>" }), // OPENAI_API_KEY; baseUrl para OpenRouter, Ollama, vLLM...
```

- **Jev** ([TypeSafe](https://docs.typesafe.ai)) responde perguntas tipadas com probabilidades calibradas em vez de texto: todo veredito vem com confiança. O padrão é o id fixado `jev-1.13.0`.
- **Compatível com a OpenAI** faz as mesmas perguntas a um modelo de chat, como booleanos num esquema JSON estrito. Não tem confiança calibrada: confira com a correção às cegas antes de confiar.
- **O seu**: qualquer objeto com `name` e `judge({ case, answer, context })` que devolva `{ pass, confidence, signals }`.

**Fixe a versão dos modelos.** Use um id com versão (snapshot datado) sempre que o provedor oferecer. Um apelido como `-latest` muda de versão sozinho e muda seus vereditos sem nenhum commit.

## Erros plantados

Uma amostra só com respostas certas mede se o juiz aprova o que está certo, nunca se ele reprova o que está errado. Os erros plantados resolvem isso: respostas erradas de propósito, presas a um caso real, avaliadas pelo juiz com o contexto que o seu app devolveu para aquele caso. O relatório mostra quantos ele pegou, por dificuldade (`obvious` ou `subtle`). Erro óbvio prova pouco; escreva os sutis: um detalhe trocado numa resposta quase certa.

## Correção às cegas

```bash
npx noxeval review
```

Uma resposta por vez: a pergunta, o que se espera e a resposta. Nenhum veredito aparece, para a sua correção não se apoiar nele. Cada resposta distinta aparece uma vez, os erros plantados vêm misturados sem marca, e a ordem é fixa por rodada. `q` sai; depois continua de onde parou.

No fim: a concordância do juiz e das verificações com você, a matriz de confusão e o **kappa de Cohen**, que é a concordância descontando a que viria por acaso. Com 24 respostas certas em 30, um juiz que aprova tudo concorda 80% das vezes e tem kappa zero.

Uma correção vale para um juiz e um modelo de juiz. Trocou um dos dois, corrija de novo.

## Portão de regressão

"Todo caso passa?" é a pergunta errada para uma suíte que muda toda semana: um caso instável conhecido reprova toda rodada, as pessoas aprendem a ignorar o vermelho, e uma regressão de verdade passa despercebida. A linha de base pergunta **"algo piorou em relação à última rodada que aceitamos?"**

```bash
npx noxeval run                       # alguns casos falham: bugs conhecidos
npx noxeval baseline update           # aceita esta rodada: grava noxeval-baseline.json
git add noxeval-baseline.json         # versione, como um lockfile
npx noxeval run --baseline noxeval-baseline.json   # ou baseline: "noxeval-baseline.json" na configuração
```

Com linha de base, a rodada sai com 1 só quando algo **regrediu**: um caso que passava e agora falha, uma falha conhecida que ganhou uma falha de segurança nova, ou um caso novo que já nasce falhando. Uma falha conhecida continua listada, mas não reprova a rodada. Um caso corrigido aparece como "fixed", com o lembrete de aceitá-lo para voltar a ser vigiado.

- `noxeval baseline update` é o único jeito de mudar a linha de base. Rodadas nunca a gravam: aceitar uma regressão é sempre uma mudança revisada, versionada junto da mudança que a causou. O comando diz o que está sendo aceito e recusa uma rodada parcial (`--only`).
- O arquivo guarda ids, vereditos, códigos de falha, taxas de acerto e custo, nunca as respostas, em ordem fixa para o diff ficar pequeno. Ele precisa ficar dentro da pasta do projeto.
- O resumo em Markdown começa pela comparação: regrediram, corrigidos, falhas conhecidas, instáveis, novos e removidos.
- Com custo informado, aparece a variação do custo por resposta e da latência p95. Alta do custo por resposta acima de `costWarnPercent` (configuração, padrão 20) é aviso, nunca falha.

A tabela completa está no [README em inglês](README.md#regression-gate).

## Na CI

`noxeval run` sai com 1 quando algum caso falha (com linha de base: quando algo regrediu) e escreve um resumo em Markdown no resumo do job do GitHub Actions. O exemplo de workflow está no [README em inglês](README.md#in-ci).

## Licença

[MIT](LICENSE) © Marcus Rodrigues
