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

Foi construído para o [Nox](https://marcusrdrigues.com), o chat com RAG do portfólio do autor, e extraído para qualquer app de LLM usar.

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

## Casos

O arquivo de casos é JSON: frases de recusa por idioma e a lista de casos. Os campos (`id`, `question`, `locale`, `expect`, `mustInclude`, `mustNotInclude`, `mustNotMatch`, `refusal`, `history`, `category`, `tags`) estão explicados na [tabela do README em inglês](README.md#cases). O arquivo é validado antes de qualquer chamada, e todos os problemas aparecem de uma vez.

`mustInclude` é uma lista de grupos: cada grupo precisa casar com um dos seus termos, sem diferenciar acento, aspas tipográficas e maiúsculas. `[["Java", "Kotlin"], ["backend"]]` quer "Java ou Kotlin" e "backend".

## Alvos

- `httpTarget({ url, answerPath?, contextPath?, toolCallsPath?, headers?, body?, timeoutMs? })` faz POST de `{ question, locale, history }` (ou do seu `body(case)`) e lê a resposta num caminho do JSON, ou o corpo inteiro como texto. `contextPath` lê o que o modelo recebeu, que o juiz usa.
- `functionTarget(nome, async (c) => ({ answer, context, toolCalls }))` para o resto: stream, SDK, chamada direta no mesmo processo.
- `toolCallsPath` / `toolCalls`: as chamadas de ferramenta de um agente, para as [verificações de trajetória](#avaliando-agentes).

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

## Na CI

`noxeval run` sai com 1 quando algum caso falha e escreve um resumo em Markdown no resumo do job do GitHub Actions. O exemplo de workflow está no [README em inglês](README.md#in-ci).

## Licença

[MIT](LICENSE) © Marcus Rodrigues
