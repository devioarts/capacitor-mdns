import { mDNS } from '@devioarts/capacitor-mdns';

window.mdnsStartBroadcast = () => {
    //const inputValue = document.getElementById("echoInput").value;
    mDNS.mdnsStartBroadcast({
        type: "_http._tcp.",
      id: "myApp",
        port: 8080,
        txt: {
            "foo": "bar"
        }
    });
}

window.mdnsStopBroadcast = () => {
    mDNS.mdnsStopBroadcast();
}

window.mdnsDiscover = () => {
  mDNS.mdnsDiscover({
        type: "_http._tcp.",
        timeoutMs: 10000
    }).then(result => {
        console.log("mdnsDiscover result", result);
    });
}
