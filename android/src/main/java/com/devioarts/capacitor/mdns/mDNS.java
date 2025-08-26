package com.devioarts.capacitor.mdns;

import com.getcapacitor.Logger;

public class mDNS {

    public String echo(String value) {
        Logger.info("Echo", value);
        return value;
    }
}
