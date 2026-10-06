!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Instalação do ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Este assistente instalará o ${PRODUCT_NAME} ${VERSION} no seu computador.$\r$\n$\r$\nDesenvolvido por: ${COMPANY_NAME}$\r$\n$\r$\nClique em Avançar para continuar."
  !insertmacro MUI_PAGE_WELCOME
!macroend
