<script setup>
import { inject } from "vue";

const isOpen = inject("dialog-open");

function open() {
  isOpen.value = true;
}
</script>

<template>
  <button type="button" class="vendor-dialog-trigger" @click="open">
    <slot />
  </button>
</template>
