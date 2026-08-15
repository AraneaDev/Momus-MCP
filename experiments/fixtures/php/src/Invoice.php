<?php

namespace App;

class Invoice
{
    public function __construct(public readonly int $id, public readonly int $totalCents)
    {
    }
}
