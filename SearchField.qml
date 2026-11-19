import QtQuick
import qs.Ui
import "Model.js" as Model

// The search box, read-only to Qt and edited here instead.
//
// An editable Qt Quick text input reads the text of every clipboard offer
// another program makes, to keep its canPaste property current. On affected
// Qt builds that Wayland read has no byte cap and no deadline, so a large or
// never-ending offer could stall the shared shell while the box exists, with
// no paste at all. Every clipboard read in QQuickTextInput (that check,
// canPaste, paste(), the paste keys and middle-click) is skipped while the
// input is read-only, so this box never leaves read-only. It applies typed
// text, Backspace, Delete and cut itself through Model.searchFieldEdit, and
// paste is deliberately not supported. Arrows, Home and End, mouse and
// keyboard selection, select-all, copy and Enter remain Qt's own.
TextField {
  id: field

  // A change made from the keyboard: typed text, a deletion or a cut.
  signal edited()
  // Escape, for the surface to clear the term or leave the box.
  signal escaped()

  readOnly: true

  // A read-only input takes no focus on press and draws no cursor of its own.
  onPressed: function(event) { field.forceActiveFocus() }
  cursorVisible: field.activeFocus
  cursorDelegate: Rectangle {
    id: caret
    width: 1
    color: field.foreground
    visible: field.activeFocus

    // Blink like the native cursor, and show solid again whenever it moves.
    Timer {
      id: blink
      interval: Math.max(1, Qt.styleHints.cursorFlashTime / 2)
      running: field.activeFocus && Qt.styleHints.cursorFlashTime >= 2
      repeat: true
      onTriggered: caret.opacity = caret.opacity > 0 ? 0 : 1
    }
    Connections {
      target: field
      function onCursorPositionChanged() {
        caret.opacity = 1
        if (blink.running) blink.restart()
      }
    }
  }

  function applyEdit(edit) {
    if (!edit) return
    var changed = edit.end > edit.start || edit.insert !== ""
    if (edit.end > edit.start) field.remove(edit.start, edit.end)
    if (edit.insert !== "") field.insert(edit.start, edit.insert)
    field.cursorPosition = edit.cursor
    if (changed) field.edited()
  }

  Keys.onPressed: function(event) {
    if (event.key === Qt.Key_Escape) {
      field.escaped()
      event.accepted = true
      return
    }
    if (event.matches(StandardKey.Cut)) {
      if (field.selectedText !== "") {
        field.copy()
        field.applyEdit(Model.searchFieldEdit(field, { key: "delete" }))
      }
      event.accepted = true
      return
    }
    var word = (event.modifiers & Qt.ControlModifier) !== 0
    var key = null
    if (event.key === Qt.Key_Backspace) key = { key: "backspace", word: word }
    else if (event.key === Qt.Key_Delete) key = { key: "delete", word: word }
    else if ((event.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) === 0)
      key = { key: "text", text: event.text }
    var edit = key ? Model.searchFieldEdit(field, key) : null
    if (!edit) return
    event.accepted = true
    field.applyEdit(edit)
  }
}
