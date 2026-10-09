# Revisão de vídeo

API HTTP para campanhas, entregas e versões de roteiro, vídeo, capa e legenda. O upload é representado por uma URL ou nome de arquivo; nenhum arquivo é transferido ou processado.

## Requisitos e execução

Requer Node.js 24 ou mais recente e npm.

~~~sh
npm ci
npm run dev
~~~

O servidor escuta em http://localhost:3000. O banco SQLite padrão fica em data/conty.sqlite; PORT e DATABASE_PATH podem ser definidos no ambiente.

Comandos disponíveis:

~~~sh
npm run build
npm run typecheck
npm test
npm start
~~~

## Regra de aprovação

Cada campanha exige ao menos uma peça, escolhida entre SCRIPT, VIDEO, COVER e CAPTION. Uma campanha que exige somente VIDEO não exige roteiro. As peças exigidas ficam bloqueadas depois da primeira entrega.

A entrega só pode receber aprovação final quando a versão atual de cada peça exigida estiver aprovada. A API salva os IDs dessas versões na aprovação.

Quando uma peça exigida recebe uma versão nova, a aprovação final anterior é invalidada na mesma transação. A versão nova começa como SUBMITTED; a entrega fica IN_PRODUCTION até essa versão ser aprovada. Depois disso, o estado passa a READY_FOR_APPROVAL. É necessária outra chamada explícita a POST /deliveries/:id/approve para aprovar a entrega; aprovar a versão da peça nunca reaproveita nem recria a aprovação final automaticamente.

Uma peça opcional não bloqueia a entrega. Nesta implementação, uma versão nova de peça opcional também não invalida a aprovação final; essa é a interpretação adotada para a ambiguidade registrada na revisão.

## Exemplo

Crie uma campanha que exige somente vídeo:

~~~http
POST /campaigns
Content-Type: application/json

{"name":"Lançamento","required_pieces":["VIDEO"]}
~~~

~~~json
{
  "id": "<campaign-id>",
  "name": "Lançamento",
  "required_pieces": ["VIDEO"],
  "created_at": "2026-10-09T12:00:00.000Z"
}
~~~

Crie uma entrega e envie uma versão por URL ou por nome de arquivo falso:

~~~http
POST /campaigns/<campaign-id>/deliveries
Content-Type: application/json

{"creator_id":"creator-1"}
~~~

~~~http
POST /deliveries/<delivery-id>/pieces/VIDEO/versions
Content-Type: application/json

{"content_url":"https://example.test/video-v1.mp4"}
~~~

A nova versão retorna um ID e estado SUBMITTED. Aprove a versão atual e, em seguida, a entrega:

~~~http
POST /versions/<version-id>/approve
POST /deliveries/<delivery-id>/approve
~~~

Se uma peça obrigatória ainda não tiver uma versão atual aprovada, a aprovação final responde HTTP 409:

~~~json
{
  "error": "REQUIRED_PIECES_NOT_APPROVED",
  "message": "A entrega possui peças obrigatórias pendentes.",
  "pending_pieces": ["VIDEO"]
}
~~~

Substituir o vídeo depois da aprovação exige aprovar a nova versão e chamar POST /deliveries/<delivery-id>/approve novamente.

## Rotas

| Método e caminho | Operação |
|---|---|
| POST /campaigns | Criar campanha e declarar required_pieces |
| GET /campaigns/:id | Consultar campanha e peças exigidas |
| PUT /campaigns/:id/required-pieces | Alterar exigências antes da primeira entrega |
| POST /campaigns/:id/deliveries | Criar entrega |
| POST /deliveries/:id/pieces/:type/versions | Criar versão por URL ou nome de arquivo |
| POST /versions/:id/approve | Aprovar a versão atual |
| POST /deliveries/:id/approve | Aprovar explicitamente as versões atuais exigidas |
| POST /versions/:id/comments | Comentar em um segundo de uma versão de vídeo |
| GET /deliveries/:id, /versions/:id/comments | Consultar estado, histórico e comentários |

Comentários pertencem ao ID exato da versão de vídeo e não são copiados para versões seguintes. O segundo precisa ser finito e não negativo.

## Limitações

A API não autentica usuários, transfere arquivos, inspeciona URLs, valida a duração real dos vídeos nem integra pagamentos. A persistência SQLite serve ao desafio local; uma implantação de alto volume ou distribuída precisaria de outra estratégia.

## Uso de IA e revisão

Codex escreveu a implementação, os testes e esta documentação. Outra sessão do Codex fez revisão técnica somente leitura, não confirmou defeito funcional e registrou a ambiguidade das peças opcionais, descrita acima. Na preparação, a pessoa responsável filtrou instruções externas ao escopo, definiu critérios e checkpoints, acompanhou as evidências e autorizou a publicação; isso não declara revisão humana linha a linha do código.
