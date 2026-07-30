package com.pcdd.sonovel.web;

import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;

public final class BridgeSourcePolicy {

    private static final Set<Integer> DISABLED_SOURCE_IDS = parseDisabledSources();

    private BridgeSourcePolicy() {
    }

    public static boolean isDisabled(int sourceId) {
        return DISABLED_SOURCE_IDS.contains(sourceId);
    }

    private static Set<Integer> parseDisabledSources() {
        String configured = System.getenv().getOrDefault("SONOVEL_DISABLED_SOURCE_IDS", "3,9,11");
        return Arrays.stream(configured.split(","))
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .map(value -> {
                    try {
                        return Integer.parseInt(value);
                    } catch (NumberFormatException ignored) {
                        return null;
                    }
                })
                .filter(value -> value != null)
                .collect(Collectors.toUnmodifiableSet());
    }
}
