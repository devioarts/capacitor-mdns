import { mDNS } from '@devioarts/capacitor-mdns';

window.testEcho = () => {
    const inputValue = document.getElementById("echoInput").value;
    mDNS.echo({ value: inputValue })
}
