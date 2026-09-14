# REGRAS DO PROJETO — POKÉMON TCG COLLECTION APP

> **IMPORTANTE:** Este arquivo contém as regras permanentes do projeto.
> Toda IA/agente de código deve ler este arquivo ANTES de analisar, modificar,
> criar ou excluir qualquer arquivo do projeto.

---

# 1. REGRA PRINCIPAL

ANTES DE QUALQUER ALTERAÇÃO NO CÓDIGO:

1. Leia este arquivo completamente.
2. Analise a estrutura atual do projeto.
3. Identifique quais funcionalidades já existem.
4. Entenda como as partes do sistema se comunicam.
5. Verifique se existe uma implementação anterior da funcionalidade solicitada.
6. Reutilize o código existente sempre que possível.
7. Só depois disso faça alterações.

**NUNCA comece criando arquivos ou reescrevendo funcionalidades sem antes entender o projeto existente.**

---

# 2. NÃO RECRIAR O PROJETO

Este projeto já possui uma estrutura e funcionalidades implementadas.

É PROIBIDO:

- Recriar o projeto do zero.
- Apagar a estrutura existente sem necessidade.
- Substituir toda a aplicação por uma implementação nova.
- Criar uma segunda arquitetura paralela.
- Duplicar funcionalidades que já existem.
- Criar arquivos desnecessários.
- Alterar tecnologias utilizadas sem uma justificativa técnica clara.

Se uma funcionalidade existente precisar ser corrigida, **corrija a implementação atual em vez de criar outra.**

---

# 3. PRESERVAR O QUE JÁ FUNCIONA

Antes de alterar qualquer código, identifique o que já está funcionando.

Não modificar ou remover funcionalidades que não estejam relacionadas à tarefa.

Exemplo:

Se a tarefa for corrigir o scanner de cartas, não alterar:

- Sistema de coleção.
- Login.
- Dashboard.
- Layout.
- Banco de dados.
- Sistema de usuários.

a menos que exista uma dependência direta.

---

# 4. NÃO INVENTAR FUNCIONALIDADES OU DADOS

Nunca utilizar:

- Dados fictícios apresentados como reais.
- Preços inventados.
- Cartas inventadas.
- APIs inexistentes.
- Endpoints fictícios.
- IDs falsos.
- Informações de mercado sem fonte.

Se uma informação não estiver disponível, informar claramente que ela não foi encontrada.

Exemplo:

```text
Preço não encontrado