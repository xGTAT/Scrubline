<script setup lang="ts">
const links = ['Home', 'About'];
</script>

<template>
  <main class="app">
    <nav id="top-nav">
      <a v-for="l in links" :key="l" href="/">{{ l }}</a>
    </nav>
    <section class="hero">
      <h1 data-testid="title">Bonjour</h1>
      <p class="tagline">Old tagline</p>
    </section>
  </main>
</template>

<style scoped>
.hero {
  background: white;
}
.tagline {
  color: gray;
}
</style>
