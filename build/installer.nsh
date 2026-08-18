; Themed NSIS installer to match the app: near-black background, cream text.
; customHeader is emitted near the top of the generated script, before the MUI
; pages are inserted, so these color defines take effect on the wizard pages.
!macro customHeader
  !ifdef MUI_BGCOLOR
    !undef MUI_BGCOLOR
  !endif
  !define MUI_BGCOLOR "0D0D0D"
  !ifdef MUI_TEXTCOLOR
    !undef MUI_TEXTCOLOR
  !endif
  !define MUI_TEXTCOLOR "E9E1D2"
!macroend
