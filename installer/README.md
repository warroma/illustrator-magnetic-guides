# Instalador do AutoLiquid

App Electron com uma tela simples: detecta o Illustrator, copia o painel (`panel/` da raiz do
repositório) para a pasta de extensões do CEP como `com.autoliquid.panel` e liga o modo de
desenvolvimento do CEP, num clique. É o mesmo instalador do AutoGrids, adaptado.

## Status

- **Windows:** gerado e testado neste Windows 11 com o Illustrator 2026 aberto: o `.exe`
  portátil abre, acha o Illustrator 2026, reinstala por cima da instalação de desenvolvimento
  (a pasta é trocada inteira e o `.debug` some) e atualiza do AutoLiquid 1 ("1.0.0 → 2.0.0").
  A pasta instalada sai idêntica a `panel/`, e o `PlayerDebugMode` fica ligado em CSXS.9–12.
- **macOS:** o `.dmg` é gerado pelo workflow de release numa máquina macOS do GitHub, mas
  nunca foi aberto num Mac de verdade. A lógica de macOS (`defaults write`, `xattr -cr`,
  caminhos) tem testes com comandos falsos.

**Sem assinatura digital** (decisão do AutoGrids, mantida aqui): o SmartScreen do Windows e o
Gatekeeper do macOS mostram "aplicativo não identificado" na primeira vez. Ver "Avisos de
segurança esperados".

## Testar a lógica (sem abrir a janela)

```bash
cd installer
npm install
npm test
```

São três suítes: `detect.test.js` (achar o Illustrator, versões, cenários), `install.test.js`
(pastas reais num diretório temporário: instalar, atualizar do AutoLiquid 1, reinstalar por cima
de uma instalação de desenvolvimento com `.debug`, pasta ligada ao código-fonte, troca que falha
no meio) e `bundle.test.js` (a pasta `panel/` de verdade: id e versão batendo com o
`package.json`, arquivos e ícones que o manifest cita, cópias do motor iguais a `engine/` e
`host/`).

## Rodar em modo de desenvolvimento

```bash
cd installer
npm install
npm start
```

O `prestart` sincroniza `engine/` e `host/` para dentro de `panel/` (`tools/install-panel.js`)
e a janela instala direto de `panel/`.

## Gerar o instalador final

```bash
cd installer
npm install
npm run dist
```

O `predist` sincroniza o painel e o `electron-builder` gera em `installer/dist/`:

- `AutoLiquid-Instalador-Windows.exe`: executável único (portátil), sem etapa de instalação
  própria. Abre direto a janela com o botão de instalar.
- `AutoLiquid-Instalador-macOS.dmg` (universal, Intel e Apple Silicon): **só no macOS**, o
  `electron-builder` não gera `.dmg` em outro sistema.

Para publicar, não é preciso gerar nada à mão: empurrar uma tag `vX.Y.Z` dispara o workflow
[`release.yml`](../.github/workflows/release.yml), que roda os testes, gera os dois arquivos em
máquinas Windows e macOS do GitHub e publica a release com as notas de
`docs/release-notes/vX.Y.Z.md`.

## Avisos de segurança esperados (sem assinatura)

- **Windows:** o SmartScreen mostra "O Windows protegeu seu PC". Clique em **Mais
  informações** → **Executar assim mesmo**.
- **macOS:** o Gatekeeper bloqueia com "não é possível abrir porque é de um desenvolvedor não
  identificado". Clique com o botão direito no app → **Abrir** → confirme (só na primeira vez).

## O que o instalador faz, exatamente

1. Procura o Illustrator: pastas com "Adobe Illustrator" no nome em `/Applications` (Mac) ou
   `Adobe` dentro de `Program Files`/`Program Files (x86)` (Windows) e, no Windows, também o
   registro de programas instalados (o Creative Cloud deixa instalar em outra unidade). É só
   para mostrar o que encontrou; não bloqueia a instalação.
2. Confere o que já está instalado em `com.autoliquid.panel` e escolhe o cenário (versão =
   `ExtensionBundleVersion` do `CSXS/manifest.xml`):

   | Situação | O que a tela oferece |
   |---|---|
   | Nada instalado | **Instalar** |
   | Versão instalada mais antiga (ex.: AutoLiquid 1, 1.0.0) | **Atualizar** ("1.0.0 → 2.0.0") |
   | Mesma versão | **Reinstalar** |
   | Versão instalada mais nova | **Voltar para a versão X** |
   | A pasta instalada é um atalho (symlink/junction) para o código-fonte | **Modo desenvolvimento**: não copia nada, só confere o modo de depuração |

   Também verifica se o Illustrator está aberto (`tasklist` / `pgrep`) e avisa antes de instalar.
3. Coloca o painel em:
   - Windows: `%APPDATA%\Adobe\CEP\extensions\com.autoliquid.panel`
   - Mac: `~/Library/Application Support/Adobe/CEP/extensions/com.autoliquid.panel`

   A pasta inteira é trocada, não copiada por cima: assim não sobram arquivos que a versão
   nova não tem mais (nem o `.debug` de uma instalação de desenvolvimento). A versão nova é
   montada ao lado (`com.autoliquid.panel.novo`) e só então troca de lugar com a antiga; se a
   troca falhar (ex.: arquivo preso pelo Illustrator aberto), a versão anterior volta para o
   lugar. O `.debug` da raiz do painel (porta de depuração remota) nunca é copiado: fica de fora
   no empacotamento (`extraResources.filter`) e na cópia (`DEV_ONLY_FILES`).
4. Liga `PlayerDebugMode` para `CSXS.9` até `CSXS.12` (`defaults write` no Mac, `reg add` em
   `HKCU` no Windows). O manifest pede CSXS 9.0.
5. No Mac, remove a quarentena da pasta copiada (`xattr -cr`).
6. No fim, **sempre** pede para fechar o Illustrator por completo e abrir de novo: ele só carrega
   uma extensão CEP nova ou atualizada ao abrir.

## Estrutura

```
installer/
├── package.json        (versão = a do painel; o electron-builder empacota ../panel)
├── build/icon.png      (gerado por tools/make-icons.js)
├── src/
│   ├── main.js         (processo principal do Electron)
│   ├── preload.js      (ponte segura entre main e a janela)
│   ├── detect.js       (lógica pura: achar o Illustrator, versões, cenário)
│   ├── install.js      (lógica pura: copiar a pasta, ligar o modo de depuração)
│   └── renderer/       (a janela: HTML/CSS/JS comum)
└── test/               (testes de detect.js/install.js e da pasta panel/, sem o Electron)
```
