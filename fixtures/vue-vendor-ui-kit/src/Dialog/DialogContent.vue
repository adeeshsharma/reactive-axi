<script setup>
import { inject } from "vue";

defineOptions({ inheritAttrs: false });

const isOpen = inject("dialog-open");

function close() {
  isOpen.value = false;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="vendor-dialog-content" v-bind="$attrs">
      <slot />
      <button type="button" class="vendor-dialog-close" @click="close">Close</button>
    </div>
  </Teleport>
</template>
