import QtQuick

Item {
    id: root
    // Only Model.barLayoutSnapshot results belong here; never mutate them in place.
    property var snapshot: null
    property var labels: ({}) // Optional ID -> display name; instance identity stays raw.
    property bool busy: false
    property color fill: "#20212d"
    property color rowFill: "#272834"
    property color foreground: "#b4c5ee"
    property color mutedForeground: "#7383a6"
    property color borderColor: "#343647"
    property color accent: "#91b6ff"
    property string fontFamily: "monospace"
    property int fontPixelSize: 13
    property real spacing: 8
    property real radius: 18
    property real rowHeight: 40
    readonly property bool dragging: heldSnapshot !== null && thresholdPassed
    signal moveRequested(var snapshot, string fromSection, int rawIndex, string targetSection, int preRemovalGap)

    property var heldSnapshot: null
    property string sourceSection: ""
    property int sourceIndex: -1
    property string heldLabel: ""
    property bool thresholdPassed: false
    property point pressPoint
    property point pointer
    property int targetColumn: -1
    property int targetGap: -1
    readonly property real pitch: rowHeight + spacing
    readonly property var sections: ["left", "center", "right"]
    implicitWidth: 630
    implicitHeight: 480
    clip: true

    function cancelDrag() {
        heldSnapshot = null;
        thresholdPassed = false;
        sourceIndex = -1;
        targetColumn = -1;
        targetGap = -1;
    }
    onSnapshotChanged: cancelDrag()
    onBusyChanged: { if (busy) cancelDrag(); }
    onVisibleChanged: { if (!visible) cancelDrag(); }
    onEnabledChanged: { if (!enabled) cancelDrag(); }
    Keys.onEscapePressed: event => {
        event.accepted = heldSnapshot !== null;
        if (event.accepted) cancelDrag();
    }

    function label(entry) {
        const id = typeof entry === "string" ? entry : entry.id;
        const value = labels && Object.prototype.hasOwnProperty.call(labels, id) ? labels[id] : id;
        return (typeof value === "string" ? value : id).slice(0, 120)
            .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
    }
    function columnAt(point) {
        for (let i = 0; i < 3; ++i) {
            const view = columns.itemAt(i).view;
            const p = view.mapFromItem(root, point.x, point.y);
            if (p.x >= 0 && p.x < view.width && p.y >= 0 && p.y < view.height)
                return i;
        }
        return -1;
    }
    function updateTarget() {
        targetColumn = columnAt(pointer);
        if (targetColumn < 0) { targetGap = -1; return; }
        const column = columns.itemAt(targetColumn);
        const p = column.view.mapFromItem(root, pointer.x, pointer.y);
        // Keep all rows in place: gaps are in the PRE-removal content coordinates.
        targetGap = Math.max(0, Math.min(column.entries.length,
            Math.floor((p.y + column.view.contentY + spacing / 2) / pitch + 0.5)));
    }
    function scrollColumn(index, delta) {
        const view = columns.itemAt(index).view;
        view.contentY = Math.max(0, Math.min(Math.max(0, view.contentHeight - view.height), view.contentY + delta));
    }

    component Caption: Text {
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: root.fontPixelSize
        textFormat: Text.PlainText
        elide: Text.ElideRight
    }
    component Card: Rectangle {
        property string labelText
        height: root.rowHeight
        radius: root.radius
        color: root.rowFill
        border.color: root.borderColor
        Caption {
            anchors.left: parent.left
            anchors.leftMargin: root.spacing
            anchors.verticalCenter: parent.verticalCenter
            text: "⠿"
            color: root.mutedForeground
        }
        Caption {
            anchors.fill: parent
            anchors.leftMargin: root.spacing + 20
            anchors.rightMargin: root.spacing
            verticalAlignment: Text.AlignVCenter
            text: parent.labelText
        }
    }
    Caption {
        id: hint
        width: parent.width
        text: "Drag widgets to change their order or move them to another section."
        color: root.mutedForeground
    }
    Row {
        anchors.top: hint.bottom
        anchors.topMargin: root.spacing
        anchors.bottom: parent.bottom
        width: parent.width
        spacing: root.spacing
        Repeater {
            id: columns
            model: root.sections
            delegate: Item {
                id: column
                required property string modelData
                required property int index
                property alias view: viewport
                readonly property var entries: root.snapshot ? root.snapshot.layout[modelData] : []
                width: (root.width - root.spacing * 2) / 3
                height: parent.height
                Caption {
                    id: heading
                    width: parent.width
                    horizontalAlignment: Text.AlignHCenter
                    text: column.modelData.toUpperCase()
                }
                Rectangle {
                    anchors.top: heading.bottom
                    anchors.topMargin: root.spacing
                    anchors.bottom: parent.bottom
                    width: parent.width
                    color: root.fill
                    radius: root.radius / 2
                    border.color: root.borderColor
                    Flickable {
                        id: viewport
                        objectName: "viewport-" + column.modelData
                        anchors.fill: parent
                        anchors.margins: root.spacing
                        contentWidth: width
                        contentHeight: Math.max(height, column.entries.length * root.pitch)
                        clip: true
                        interactive: false // One pointer owner; wheel and edge scrolling below.
                        Repeater {
                            model: column.entries
                            delegate: Card {
                                required property var modelData
                                required property int index
                                objectName: "row-" + column.modelData + "-" + index
                                width: viewport.width
                                y: index * root.pitch
                                labelText: root.label(modelData)
                                opacity: root.dragging && root.sourceSection === column.modelData && root.sourceIndex === index ? 0.3 : 1
                            }
                        }
                        Caption {
                            anchors.centerIn: parent
                            width: viewport.width
                            horizontalAlignment: Text.AlignHCenter
                            text: "Drop widgets here"
                            visible: column.entries.length === 0
                            color: root.mutedForeground
                        }
                        Rectangle {
                            objectName: "insertion-" + column.modelData
                            visible: root.dragging && root.targetColumn === column.index
                            y: Math.max(0, root.targetGap * root.pitch - root.spacing / 2)
                            width: viewport.width
                            height: 2
                            color: root.accent
                        }
                    }
                }
            }
        }
    }
    MouseArea {
        id: pointerArea
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        preventStealing: true
        onPressed: mouse => {
            root.cancelDrag();
            if (root.busy || !root.snapshot) return;
            const point = Qt.point(mouse.x, mouse.y);
            const index = root.columnAt(point);
            if (index < 0) return;
            const column = columns.itemAt(index);
            const local = column.view.mapFromItem(root, mouse.x, mouse.y);
            const y = local.y + column.view.contentY;
            const row = Math.floor(y / root.pitch);
            if (row >= column.entries.length || y % root.pitch >= root.rowHeight) return;
            root.forceActiveFocus();
            root.sourceSection = column.modelData;
            root.sourceIndex = row;
            root.heldLabel = root.label(column.entries[row]);
            root.pressPoint = point;
            root.pointer = point;
            root.heldSnapshot = root.snapshot;
        }
        onPositionChanged: mouse => {
            if (!root.heldSnapshot) return;
            root.pointer = Qt.point(mouse.x, mouse.y);
            if (Math.hypot(mouse.x - root.pressPoint.x, mouse.y - root.pressPoint.y) >= Qt.styleHints.startDragDistance)
                root.thresholdPassed = true;
            if (root.dragging) root.updateTarget();
        }
        onReleased: mouse => {
            root.pointer = Qt.point(mouse.x, mouse.y);
            root.updateTarget();
            const saved = root.heldSnapshot;
            const from = root.sourceSection, index = root.sourceIndex;
            const to = root.sections[root.targetColumn], gap = root.targetGap;
            const valid = root.dragging && !root.busy && saved.key === root.snapshot.key && root.targetColumn >= 0
                && !(from === to && (gap === index || gap === index + 1));
            root.cancelDrag(); // Clear before notifying a potentially synchronous receiver.
            if (valid) root.moveRequested(saved, from, index, to, gap);
        }
        onCanceled: root.cancelDrag()
        onWheel: wheel => {
            const index = root.columnAt(Qt.point(wheel.x, wheel.y));
            if (index >= 0) root.scrollColumn(index, -(wheel.pixelDelta.y || wheel.angleDelta.y / 120 * root.pitch));
            if (root.dragging) root.updateTarget();
        }
    }
    Timer {
        interval: 30
        repeat: true
        running: root.dragging && root.targetColumn >= 0
        onTriggered: {
            const view = columns.itemAt(root.targetColumn).view;
            const y = view.mapFromItem(root, root.pointer.x, root.pointer.y).y;
            const edge = Math.min(root.rowHeight, view.height / 3);
            const delta = y < edge ? -8 : y > view.height - edge ? 8 : 0;
            if (delta) { root.scrollColumn(root.targetColumn, delta); root.updateTarget(); }
        }
    }
    Card {
        objectName: "drag-ghost"
        visible: root.dragging
        x: root.pointer.x + root.spacing
        y: root.pointer.y + root.spacing
        width: Math.max(0, (root.width - root.spacing * 2) / 3 - root.spacing * 2)
        labelText: root.heldLabel
        opacity: 0.85
        border.color: root.accent
    }
}
