# AutoLiquid 2

Painel para o Adobe Illustrator que faz formas se comportarem como líquido: quando duas formas
chegam perto, nasce uma ponte entre elas, e ela se desfaz quando se afastam. Atualiza em tempo
real enquanto você mexe nas formas. **Pregnância**, **tensão** e as outras variáveis são
ajustáveis por líquido.

É a evolução do AutoLiquid 1 (ponte de bézier entre 2 elipses, PR fechado no repositório do
AutoGrids). A matemática agora é a do vídeo de referência (campo de distância + união suave),
generalizada para qualquer forma e qualquer quantidade. Os cálculos estão em
[docs/CALCULOS.md](docs/CALCULOS.md).

## Instalar (máquina de desenvolvimento)

```bash
node tools/install-panel.js --install
```

Feche e abra o Illustrator; o painel fica em **Janela > Extensões > AutoLiquid**. Ele instala por
cima do AutoLiquid 1 (mesmo id); a versão anterior vai para `_backup/`. O modo de extensões não
assinadas (`PlayerDebugMode`) já está ligado nesta máquina por causa do AutoGrids.

`--dev` liga também a porta de depuração remota (`localhost:8098`), usada pelos testes
automáticos do painel.

## Usar

1. Selecione as formas (círculos, retângulos, estrelas, paths, paths compostos, grupos).
2. **Criar líquido com a seleção**. As formas vão para um grupo "Líquido" e o contorno líquido
   aparece por cima delas. A pregnância inicial é proporcional ao tamanho das formas.
3. Mexa nas formas e o líquido acompanha ao soltar o mouse:
   - **duplo clique** no líquido entra no modo isolamento, onde a Seleção (V) move cada forma;
   - ou use a **Seleção Direta (A)** clicando dentro da forma.
4. Ajuste no painel o líquido selecionado (ou o último usado).

| Controle | O que faz |
|---|---|
| Pregnância | vão em que as formas se tocam (mm ou pt). Escala quadrática: fino nos valores pequenos |
| Tensão | forma da ponte: **Esticada** (reta, sem puxão antes de tocar) → **Mole** (gota, puxa de longe) |
| Engordar | cresce ou afina o líquido inteiro |
| Avançado › Curva de fusão | **Líquido** (padrão) · **Magnética** (a fórmula do vídeo) · **Filete** (= Offset nativo) · **Sem ponte** |
| Avançado › Precisão | tolerância do contorno: mais fiel (mais âncoras) ou mais leve |
| Expandir | o contorno vira um path comum e as formas-fonte saem (Ctrl+Z traz de volta) |
| Desfazer líquido | apaga o contorno e devolve as formas soltas |

- **Cor e traço**: o líquido copia o estilo da forma do topo do grupo; mude a cor dela e ele
  acompanha.
- **Adicionar formas**: coloque-as dentro do grupo (painel Camadas, ou colando no modo
  isolamento). Para tirar, é só tirar do grupo. Forma oculta não entra na conta.
- **Duplicar, copiar/colar, apagar**: funciona como em qualquer grupo; a cópia é um líquido
  independente.
- **Desfazer**: cada atualização é um passo. Ctrl+Z volta o contorno e o painel não briga com
  isso (testado).

## Como fica no documento

```
Grupo "Líquido"            note = AutoLiquid|1|reach=..;tension=..;kernel=..;grow=..;tol=..
  Contorno líquido         path composto, travado, no topo  (note = ALOUT|<assinaturas>)
  ...formas-fonte...
```

O contorno sempre contém a união das formas, por isso as cobre. Como está travado, o clique
atravessa e pega a forma de baixo. Os parâmetros moram no próprio documento (no grupo), não no
painel; ao abrir um arquivo, o painel reencontra os líquidos varrendo os grupos.

## Script (sem painel)

Mesmo motor e mesmo controlador do painel, conversando com o Illustrator por COM:

```bash
node cli/liquid.js demo
```

| Comando | |
|---|---|
| `node cli/liquid.js demo` | cena de exemplo já líquida |
| `node cli/liquid.js cena` | só as formas do exemplo, selecionadas |
| `node cli/liquid.js criar --alcance 30 --tensao 2` | seleção → líquido |
| `node cli/liquid.js ajustar --alcance 40` | ajusta o líquido selecionado |
| `node cli/liquid.js vigiar` | tempo real pelo terminal (não use junto com o painel aberto) |
| `node cli/liquid.js validar` | bateria de testes no Illustrator real (pausa o painel se ele estiver aberto) |

## Testes

```bash
node tests/harness.js
```

- `tests/harness.js`: 28 testes do motor (círculo continua círculo, retângulo com 4 cantos
  exatos, estrela sozinha intacta, conexão exatamente no alcance, independência de ordem, BVH =
  força bruta, bézier a < 0,1 pt do contorno exato) + métricas por curva + desempenho. Gera
  `relatorio/comparativo.html`.
- `tests/host-json.test.js`: serializador JSON do lado ExtendScript.
- `node cli/liquid.js validar`: 19 testes no Illustrator real (criar, arrastar sem reler pontos,
  conectar no alcance, parâmetros, desfazer/refazer, girar, editar âncora, cor, duplicar,
  expandir, desfazer líquido, carga com 40 círculos).
- `tools/latency.js`: latência ponta a ponta com o painel no comando.

## Desempenho medido (Illustrator 30.8, esta máquina)

| | |
|---|---|
| calcular 2 / 10 / 40 / 100 círculos | 1 / 5 / 27 / 90 ms |
| path de 400 âncoras + 6 círculos | 25 ms |
| atualizar 8 formas no Illustrator (calcular + escrever) | ~23 ms |
| arrastar 1 de 40 círculos | ~58 ms |
| vigilância por ciclo (8 formas) | ~1 ms no Illustrator, ~5 ms ida e volta |
| do movimento ao contorno novo, ponta a ponta | ~100–130 ms |

A latência ponta a ponta tem como piso o **redesenho do próprio Illustrator** depois de cada
mudança (35–70 ms medidos); a parte do AutoLiquid é ~30 ms. A vigilância é adaptativa (60 a
400 ms, mirando ~5% do tempo do Illustrator).

## Limitações conhecidas

- Atualiza **ao soltar** o mouse, não durante o arraste (painéis CEP não recebem eventos do meio
  do arraste).
- Texto, imagens e símbolos dentro do grupo são ignorados (contorne o texto antes).
- O líquido tem uma cor só (a da forma do topo).
- Paths abertos são preenchidos como se fossem fechados, igual ao Illustrator; uma linha só com
  traço não vira tubo.
- Arrastar um slider gera um passo de desfazer por atualização.

## Estrutura

```
engine/liquid-core.js        motor: SDF, curvas, contorno, bézier (Node e painel)
engine/liquid-controller.js  vigiar → ler → calcular → escrever (Node e painel)
host/liquid-host.jsx         lado Illustrator (ExtendScript)
panel/                       extensão CEP (js/ e jsx/ recebem cópias via tools/install-panel.js)
cli/                         script por COM + bateria de validação
tools/                       instalador, ponte COM, depuração do painel, latência, exportar PNG
tests/                       harness do motor e teste do JSON do host
probes/                      sondas de capacidade/custo do Illustrator usadas nas decisões
docs/CALCULOS.md             os cálculos, com medidas
relatorio/                   comparativo visual das curvas e PNGs de conferência
```
