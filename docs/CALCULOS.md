# Cálculos do AutoLiquid 2

Como as formas se relacionam e se conectam. Tudo aqui está implementado em
`engine/liquid-core.js` e medido por `tests/harness.js` (os números abaixo vêm de lá).

## 1. Do Desmos/shader para o Illustrator

A referência (vídeo "Math and Shaders") faz:

| Desmos | O que é | No AutoLiquid |
|---|---|---|
| `Dot(a,b)`, `Length(v)` | produto escalar e comprimento | iguais |
| `P_i = Length(p − c_i)` | distância do ponto ao **centro** de cada círculo | trocado por **distância com sinal até o contorno** (SDF) de qualquer forma |
| `s < 0.1` | limiar = raio (todos os círculos do mesmo tamanho) | o limiar vira 0 do SDF, então cada forma tem o seu tamanho |
| `Smin(a,b,k) = ½·(a + b − √((a−b)² + 2k²))` | união suave "raiz" | disponível como curva **Magnética** |
| `s0 = Smin(P0,P1)`, `s1 = Smin(s0,P2)` | encadeia par a par | encadeia em **ordem crescente de distância** (resultado não depende da ordem das formas) |

O contorno líquido é o conjunto de pontos onde o campo combinado vale 0.

## 2. Campo de cada forma (SDF)

`d(p)` = distância de `p` até o contorno da forma, negativa dentro, positiva fora.

- **Círculo** (reconhecido no path de 4 âncoras): `d = |p − c| − r`, exato e O(1).
- **Retângulo alinhado**: SDF de caixa, exato e O(1).
- **Qualquer outro path** (elipse, estrela, path composto com furo, path orgânico): o contorno bézier
  é achatado em segmentos (tolerância 0,02 pt), a distância é a do segmento mais próximo
  (busca numa BVH, O(log n)) e o sinal vem da regra par-ímpar (furos funcionam).

Usar a distância até o **contorno**, e não até o centro, é o que permite misturar tamanhos e
tipos de forma, e faz a "pregnância" valer igual para todas.

## 3. União suave — as curvas

Todas foram **normalizadas pelo alcance A** (a "Pregnância" do painel): duas formas iguais
se tocam exatamente quando o vão entre elas fica menor que A, seja qual for a curva. No ponto
do meio entre elas (`a = b`) todas descontam o mesmo `A/2`, por isso a cintura da ponte é
idêntica em todas. O que muda é o **formato** da ponte e o quanto as formas se puxam antes
de encostar.

| Curva (painel) | Fórmula | Age até | Observação |
|---|---|---|---|
| **Líquido** — polinomial, tensão `p` (padrão p = 2) | `k = p·A`, `h = max(k − |a−b|, 0)/k`, `smin = min(a,b) − k·hᵖ/(2p)` | `|a−b| < p·A` | p = 1: ponte reta e esticada (chanfro); p = 2: quadrática clássica (Inigo Quilez); p = 3: cúbica; p alto: mole, começa a puxar de longe |
| **Magnética** — raiz (a do vídeo) | `smin = ½·(a + b − √((a−b)² + A²))` | sempre | nunca solta de vez: tudo atrai tudo. Equivale ao Desmos com `A = √2·k` |
| **Filete** — circular | `k' = (A/2)/(1 − √½)`, `smin = min − k'·½·(1 + h − √(1 − h(h−2)))` | `|a−b| < 1,71·A` | junção em arco de círculo; é o que o truque nativo Offset + Unir + Offset negativo faz |
| **Sem ponte** — união dura | `min(a,b)` | — | referência |
| (só no motor) exponencial N-ária | `−κ·ln Σ e^(−dᵢ/κ)`, `κ = A/(2 ln 2)` | ~12κ | não depende de ordem por construção; na prática ≈ polinomial com p alto |

**Tensão no painel**: slider "Esticada → Mole" = `p` de 1 a 4. Por que `p` também é o
alcance da influência: para a ponte ser lisa onde encosta na forma (sem quina), a curva tem que
começar a agir pelo menos ~1,5–2 A antes. Não dá pra ter junção lisa sem algum "puxão" antes
do contato — dá pra escolher quanto.

### Medidas (2 círculos R = 50, alcance A = 30)

Pescoço (largura da ponte no meio), em pt:

| vão / A | 0 | 0,25 | 0,5 | 0,75 | 0,95 | 1,1 |
|---|---|---|---|---|---|---|
| todas as curvas | 83,1 | 73,1 | 60,6 | 43,5 | 19,7 | 0 (soltou) |

Inchaço da face interna antes de encostar (pt) e deformação do lado **oposto** (pt, ideal 0):

| curva | inchaço 1,1·A | inchaço 1,5·A | inchaço 2,5·A | lado oposto (sempre) |
|---|---|---|---|---|
| Líquido p = 1 | 0 | 0 | 0 | 0 |
| Líquido p = 2 | 7,0 | 1,3 | 0 | 0 |
| Líquido p = 3 | 8,0 | 2,6 | 0,1 | 0 |
| Líquido p = 6 | 8,7 | 3,7 | 0,6 | até 0,1 |
| Filete | 6,2 | 0,4 | 0 | 0 |
| Magnética (vídeo) | 9,6 | 5,7 | **3,1** | **1,3 a 2,2** |
| Exponencial | 8,4 | 3,4 | 0,7 | até 0,2 |

Leitura: a fórmula do vídeo dá o efeito "magnético", mas **deforma tudo para sempre**
(um círculo a 2,5× o alcance ainda fica torto 1,3 pt do lado de trás) e é a mais cara com
muitas formas, porque não dá pra ignorar as distantes. Por isso o padrão é a polinomial: solta no
alcance, formas soltas ficam fiéis, e só as formas próximas entram na conta.

## 4. Mais de duas formas

Em cada ponto, as distâncias são **ordenadas** e encadeadas da menor para a maior. Isso torna o
resultado independente da ordem das formas no documento (testado: variação de área 0,000 pt²
trocando a ordem). Com curvas de alcance finito, formas cuja caixa está mais longe que
`menor distância + alcance` nem são calculadas (índice espacial + BVH).

## 5. Do campo ao path

1. **Grade adaptativa (quadtree)**: o campo é 1-Lipschitz (muda no máximo 1 pt por pt
   andado), então um bloco cujos cantos estão todos a mais de uma diagonal do zero não contém
   contorno e é descartado inteiro. Só a faixa em volta do contorno é refinada.
2. **Marching squares** com desempate de sela pelo valor exato no centro da célula.
3. **Projeção de Newton**: cada vértice desliza até o contorno exato (o SDF é quase linear ali,
   1 passo basta). A precisão vem daqui, não da grade.
4. **Refino adaptativo + cantos**: entre vizinhos cuja normal gira mais de 10°, insere o ponto do
   meio (também projetado). Se o giro não diminui nem com os pontos colados, é **canto vivo**:
   o canto exato é a interseção das duas tangentes (retângulos saem com 4 âncoras e cantos
   exatos).
5. **Ajuste bézier (Schneider)** com tangentes tiradas do gradiente do campo, e uma passada que
   **funde segmentos** enquanto um só ainda couber na tolerância (círculo isolado: 6 âncoras).

Resultado medido: o bézier desenhado fica a menos de 0,1 pt do contorno matemático em todas as
curvas.

## 6. Os outros controles

- **Engordar**: desloca o nível do contorno (`F − g = 0`): cresce ou afina tudo, como um
  Offset Path aplicado ao líquido inteiro.
- **Precisão do contorno**: tolerância do ajuste bézier (0,02 a 0,5 pt). Mais fiel = mais
  âncoras.

## 7. Por que não só o efeito nativo do Illustrator

Efeito > Desfoque não serve (é raster). O truque vetorial nativo é Pathfinder Unir + Deslocar
Demarcador (+k) + Deslocar (−k), que matematicamente é um "fechamento". Ele dá a curva **Filete**,
mas:

- também arredonda os cantos côncavos **de cada forma sozinha** (uma estrela perde as pontas
  internas), enquanto aqui a pregnância só age **entre** formas (testado: estrela sozinha sai
  idêntica, mesma área e 10 âncoras);
- não tem tensão nem puxão antes do contato;
- não tem a fórmula do vídeo.

A curva Filete está no painel justamente para comparar com esse resultado.
