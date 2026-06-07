function loadEelScript() {
    if (window.location.protocol && window.location.protocol.startsWith("http")) {
        const script = document.createElement("script");
        script.type = "text/javascript";
        script.src = "/eel.js";
        document.head.appendChild(script);
    }
}