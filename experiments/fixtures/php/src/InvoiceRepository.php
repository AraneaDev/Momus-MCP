<?php

namespace App;

class InvoiceRepository
{
    public function findById(int $id): Invoice
    {
        throw new \RuntimeException('real repo not available in tests');
    }

    public function save(Invoice $invoice): void
    {
    }
}
